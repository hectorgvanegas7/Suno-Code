#!/usr/bin/env python3
# lib/clap_score.py — Evalúa calidad de audio con CLAP (Contrastive Language-Audio
# Pretraining) y devuelve JSON. 100% local, cero API de nube.
#
# Uso: python clap_score.py <audio...> [--device cuda|cpu] [--model MODEL_ID] [--dims a,b,c]
#   - Positionals que terminan en .mp3/.wav/.m4a/.flac/.ogg son audios.
#   - Con VARIOS audios el modelo se carga UNA sola vez (mismo patrón que transcribe.py).
#   - Sin --device: cpu (seguro). Con --device cuda: intenta CUDA y si falla,
#     reintenta automáticamente en CPU (warning a stderr, JSON limpio a stdout).
#   - --model: ID de HuggingFace (default: laion/clap-htsat-unfused).
#   - --dims: subconjunto de dimensiones a calcular, separadas por coma (default:
#     las 5). clap_score y el weighted-average se calculan solo sobre esas
#     dimensiones. Pensado para callers que corren CLAP dos veces sobre distintas
#     fuentes (ej. voz aislada vs mix completo) y después recombinan resultados.
#   - --jobs-stdin: en vez de leer archivos/--dims de argv, lee por stdin un
#     array JSON de jobs — [{"file": "...", "dims": ["vocal_clarity", ...]}] —
#     y los procesa todos con el modelo cargado UNA sola vez, incluso si cada
#     job pide un subconjunto de --dims distinto (ej. mix + voz aislada de A y
#     B en una sola invocación en vez de dos). Ignora los positionals/--dims de
#     argv en este modo. "dims" es opcional por job (default: las 5).
#
# Output (stdout, una sola línea JSON):
#   - 1 audio  → objeto único (backward-compatible con callers de 1 archivo).
#   - N audios → { "batch": true, "results": [{ ... }] }.
#   Cada resultado incluye:
#     clap_score:  0-100 (promedio ponderado de las dimensiones activas)
#     dimensions:  { vocal_clarity, production, emotion, artifacts, ending } (o subset con --dims)
#     weights:     peso usado por cada dimensión activa — para recombinar sin
#                  duplicar la tabla de pesos en otro lenguaje
#     model, device, chunks_analyzed, duration_seconds
#   Si falla globalmente, imprime {"error": "mensaje"} y sale con código 1.
#
# Estrategia de evaluación:
#   - 5 dimensiones con prompts antónimos (positivo vs negativo)
#   - Score por dimensión = sim_pos / (sim_pos + sim_neg) * 100
#   - Chunking: 5 ventanas de ~7s al 10%, 30%, 50%, 70%, 90% del track
#   - Mean-pooling + re-normalización L2 del embedding agregado
#
# Instalación:
#   pip install transformers librosa torch
#   (torch ya debería estar instalado para Whisper/demucs)

import sys
import json
import time
import os
import warnings

# Suprimir warnings de transformers/torch que ensuciarían stderr
warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)
os.environ["TOKENIZERS_PARALLELISM"] = "false"

AUDIO_EXTENSIONS = (".mp3", ".wav", ".m4a", ".flac", ".ogg")

# ─── Dimensiones de evaluación ────────────────────────────────────────────────
# Cada dimensión tiene un prompt positivo y uno negativo (estrategia antónima).
# El score se calcula como: sim_pos / (sim_pos + sim_neg) * 100
# Esto normaliza el score entre 0-100 independientemente de la magnitud absoluta
# de las similitudes coseno (que varían mucho entre modelos CLAP).

DIMENSIONS = {
    "vocal_clarity": {
        "positive": "clear natural singing voice with professional studio quality",
        "negative": "distorted muffled singing voice with poor audio quality",
        "weight": 1.0,
    },
    "production": {
        "positive": "professionally produced music with clean mix and mastering",
        "negative": "low quality recording with noise hiss and digital artifacts",
        "weight": 1.0,
    },
    "emotion": {
        "positive": "emotional expressive heartfelt vocal performance",
        "negative": "flat monotone lifeless robotic singing",
        "weight": 0.8,  # Ligeramente menos peso — más subjetivo
    },
    "artifacts": {
        "positive": "clean audio recording without glitches or interruptions",
        "negative": "audio with static noise clicks pops and digital glitches",
        "weight": 1.2,  # Más peso — artefactos son deal-breakers
    },
    "ending": {
        "positive": "song with smooth natural fade out ending",
        "negative": "audio that stops suddenly with abrupt cutoff",
        "weight": 0.8,  # Menos peso — ya lo detecta detectAbruptCutoff() en Node
    },
}

# Puntos de muestreo en el track (porcentaje del largo total).
# 5 puntos capturan intro, verso, coro, verso2 y final de una canción de ~3 min.
CHUNK_OFFSETS = [0.10, 0.30, 0.50, 0.70, 0.90]
CHUNK_DURATION_SEC = 7  # Ventana nativa de CLAP ~7 segundos
TARGET_SR = 48000  # CLAP espera 48kHz


def parse_args(argv):
    args = {
        "audio_paths": [],
        "device": "cpu",
        "model_id": "laion/clap-htsat-unfused",
        "dims": None,  # None = las 5 dimensiones (default, compatible con callers viejos)
        "jobs_stdin": False,
    }
    i = 0
    while i < len(argv):
        if argv[i] == "--device" and i + 1 < len(argv):
            args["device"] = argv[i + 1]
            i += 2
        elif argv[i] == "--model" and i + 1 < len(argv):
            args["model_id"] = argv[i + 1]
            i += 2
        elif argv[i] == "--dims" and i + 1 < len(argv):
            args["dims"] = [d.strip() for d in argv[i + 1].split(",") if d.strip()]
            i += 2
        elif argv[i] == "--jobs-stdin":
            args["jobs_stdin"] = True
            i += 1
        elif argv[i].lower().endswith(AUDIO_EXTENSIONS):
            args["audio_paths"].append(argv[i])
            i += 1
        else:
            # Argumento desconocido — ignorar (forward-compatible)
            i += 1
    return args


def load_model_and_processor(model_id, device):
    """Carga el modelo CLAP y su procesador. Fallback CUDA→CPU automático."""
    from transformers import AutoModel, AutoProcessor

    if device == "cuda":
        try:
            import torch

            if not torch.cuda.is_available():
                raise RuntimeError("CUDA no disponible en este sistema")
            model = AutoModel.from_pretrained(model_id).to("cuda")
            processor = AutoProcessor.from_pretrained(model_id)
            print(
                f"✅ CLAP cargado en CUDA ({torch.cuda.get_device_name(0)})",
                file=sys.stderr,
            )
            return model, processor, "cuda"
        except Exception as e:
            print(
                f"⚠️  CUDA no disponible/falló para CLAP ({e}), usando CPU.",
                file=sys.stderr,
            )
            model = AutoModel.from_pretrained(model_id)
            processor = AutoProcessor.from_pretrained(model_id)
            return model, processor, "cpu"
    else:
        model = AutoModel.from_pretrained(model_id)
        processor = AutoProcessor.from_pretrained(model_id)
        return model, processor, "cpu"


def load_audio_chunks(audio_path):
    """Carga un audio y extrae N chunks de CHUNK_DURATION_SEC segundos
    en los puntos CHUNK_OFFSETS del track. Resamplea a TARGET_SR (48kHz).
    Devuelve (chunks_list, duration_seconds) o lanza si falla."""
    import librosa
    import numpy as np

    # librosa.load resamplea automáticamente; mono por defecto
    audio, sr = librosa.load(audio_path, sr=TARGET_SR, mono=True)
    duration_sec = len(audio) / sr

    if duration_sec < CHUNK_DURATION_SEC:
        # Audio demasiado corto para chunking — usar completo
        return [audio], duration_sec

    chunk_samples = int(CHUNK_DURATION_SEC * sr)
    max_start = len(audio) - chunk_samples
    chunks = []

    for offset_pct in CHUNK_OFFSETS:
        start_sample = int(offset_pct * max_start)
        # Asegurar que no exceda los límites
        start_sample = max(0, min(start_sample, max_start))
        chunk = audio[start_sample : start_sample + chunk_samples]

        # Validar que el chunk no sea silencio puro (RMS < -60 dB)
        rms = np.sqrt(np.mean(chunk**2))
        if rms > 1e-6:  # ~-120 dB — solo descarta silence absoluto
            chunks.append(chunk)

    if not chunks:
        # Todos los chunks son silencio — devolver el audio completo como fallback
        return [audio], duration_sec

    return chunks, duration_sec


def compute_embeddings(model, processor, audio_chunks, text_prompts, device):
    """Computa embeddings de audio (mean-pooled de chunks) y texto.
    Devuelve (audio_embed, text_embeds) ambos L2-normalizados."""
    import torch
    import numpy as np

    # ── Audio embedding (mean-pool de chunks) ──────────────────────────────
    chunk_embeds = []
    for chunk in audio_chunks:
        inputs = processor(
            audio=chunk,
            sampling_rate=TARGET_SR,
            return_tensors="pt",
            padding=True,
        )
        if device == "cuda":
            inputs = {k: v.to("cuda") if hasattr(v, "to") else v for k, v in inputs.items()}

        with torch.no_grad():
            out = model.get_audio_features(**inputs)
        # out shape: (1, embed_dim)
        chunk_embeds.append(out.pooler_output.cpu().numpy().flatten())

    # Mean-pool + re-normalización L2
    avg_embed = np.mean(chunk_embeds, axis=0)
    norm = np.linalg.norm(avg_embed)
    if norm > 0:
        avg_embed = avg_embed / norm
    audio_embed = torch.from_numpy(avg_embed).unsqueeze(0)  # (1, embed_dim)
    if device == "cuda":
        audio_embed = audio_embed.to("cuda")

    # ── Text embeddings ────────────────────────────────────────────────────
    text_inputs = processor(
        text=text_prompts,
        return_tensors="pt",
        padding=True,
    )
    if device == "cuda":
        text_inputs = {k: v.to("cuda") if hasattr(v, "to") else v for k, v in text_inputs.items()}

    with torch.no_grad():
        text_out_obj = model.get_text_features(**text_inputs)
        text_out = text_out_obj.pooler_output
    # Normalizar text embeddings
    text_embeds = text_out / text_out.norm(dim=-1, keepdim=True)

    return audio_embed.float(), text_embeds.float()


def score_one(model, processor, audio_path, device, dims=None):
    """Evalúa un archivo de audio. `dims`: lista opcional de nombres de
    DIMENSIONS a calcular (None = las 5). Útil para evaluar solo vocal_clarity/
    emotion sobre un stem de voz aislada, o solo production/artifacts/ending
    sobre el mix completo (esas 3 evalúan la mezcla, no tienen sentido sobre
    una pista de voz sola). Devuelve dict con scores, pesos usados, o error."""
    import torch

    if dims is not None:
        unknown = [d for d in dims if d not in DIMENSIONS]
        if unknown:
            raise ValueError(f"Dimensiones desconocidas: {', '.join(unknown)} (válidas: {', '.join(DIMENSIONS)})")
        active_dimensions = {k: v for k, v in DIMENSIONS.items() if k in dims}
        if not active_dimensions:
            raise ValueError("--dims no dejó ninguna dimensión activa")
    else:
        active_dimensions = DIMENSIONS

    chunks, duration_sec = load_audio_chunks(audio_path)

    # Recopilar todos los prompts (positivos y negativos intercalados)
    all_prompts = []
    dim_order = []
    for dim_name, dim_cfg in active_dimensions.items():
        all_prompts.append(dim_cfg["positive"])
        all_prompts.append(dim_cfg["negative"])
        dim_order.append(dim_name)

    audio_embed, text_embeds = compute_embeddings(
        model, processor, chunks, all_prompts, device
    )

    # Calcular similitudes coseno (audio_embed ya normalizado, text_embeds también)
    similarities = torch.mm(audio_embed, text_embeds.T).squeeze(0).cpu().numpy()

    # Score por dimensión
    dimensions = {}
    weighted_sum = 0.0
    weight_total = 0.0

    for i, dim_name in enumerate(dim_order):
        sim_pos = float(similarities[i * 2])       # prompt positivo
        sim_neg = float(similarities[i * 2 + 1])   # prompt negativo

        # Normalizar a 0-100 usando ratio positivo/(positivo+negativo)
        # Esto es robusto a variaciones en la magnitud absoluta de las similitudes
        denom = abs(sim_pos) + abs(sim_neg)
        if denom > 1e-8:
            dim_score = round(max(0, min(100, (sim_pos / denom) * 100)))
        else:
            dim_score = 50  # Indeterminado → neutro

        dimensions[dim_name] = dim_score
        weight = active_dimensions[dim_name]["weight"]
        weighted_sum += dim_score * weight
        weight_total += weight

    # Score global = promedio ponderado (solo de las dimensiones activas)
    clap_score = round(weighted_sum / weight_total) if weight_total > 0 else 50

    # weights viaja en la respuesta para que quien combine resultados de varias
    # corridas (ej. mix + voz aislada) recalcule el promedio ponderado global
    # sin tener que duplicar esta tabla de pesos en otro lenguaje.
    weights = {dim_name: active_dimensions[dim_name]["weight"] for dim_name in dim_order}

    return {
        "clap_score": clap_score,
        "dimensions": dimensions,
        "weights": weights,
        "chunks_analyzed": len(chunks),
        "duration_seconds": round(duration_sec, 1),
    }


def main():
    if len(sys.argv) < 2:
        print(
            json.dumps(
                {
                    "error": "Uso: python clap_score.py <audio...> [--device cuda|cpu] [--model MODEL_ID]"
                }
            )
        )
        sys.exit(1)

    args = parse_args(sys.argv[1:])

    jobs = None
    if args["jobs_stdin"]:
        try:
            jobs = json.loads(sys.stdin.read())
            if not isinstance(jobs, list) or not jobs:
                raise ValueError("el JSON de stdin debe ser una lista no vacía de jobs")
            for j in jobs:
                if not isinstance(j, dict) or "file" not in j:
                    raise ValueError('cada job necesita al menos {"file": "..."}')
        except Exception as e:
            print(json.dumps({"error": f"--jobs-stdin: JSON inválido en stdin: {e}"}))
            sys.exit(1)
    elif not args["audio_paths"]:
        print(
            json.dumps(
                {
                    "error": "No se pasó ningún archivo de audio (.mp3/.wav/.m4a/.flac/.ogg)."
                }
            )
        )
        sys.exit(1)

    # Fail-fast: verificar dependencias antes de cargar nada pesado
    missing = []
    try:
        import transformers  # noqa: F401
    except ImportError:
        missing.append("transformers")
    try:
        import librosa  # noqa: F401
    except ImportError:
        missing.append("librosa")
    try:
        import torch  # noqa: F401
    except ImportError:
        missing.append("torch")

    if missing:
        print(
            json.dumps(
                {
                    "error": f"Dependencias faltantes: {', '.join(missing)}. "
                    f"Corrí: pip install {' '.join(missing)}"
                }
            )
        )
        sys.exit(1)

    # Verificar que los archivos existen antes de cargar el modelo
    files_to_check = [j["file"] for j in jobs] if jobs is not None else args["audio_paths"]
    for ap in files_to_check:
        if not os.path.isfile(ap):
            print(json.dumps({"error": f"Archivo no encontrado: {ap}"}))
            sys.exit(1)

    # Cargar modelo (una sola vez para todos los archivos)
    load_start = time.time()
    try:
        model, processor, actual_device = load_model_and_processor(
            args["model_id"], args["device"]
        )
    except Exception as e:
        print(json.dumps({"error": f"Error cargando modelo CLAP: {e}"}))
        sys.exit(1)
    load_ms = int((time.time() - load_start) * 1000)
    print(f"   CLAP modelo cargado en {load_ms}ms", file=sys.stderr)

    # Procesar cada archivo. En --jobs-stdin cada job puede pedir un subconjunto
    # de dimensiones distinto (ej. mix completo vs voz aislada) sin pagar una
    # carga de modelo por cada uno — el modelo ya se cargó una sola vez arriba,
    # independientemente de cuántos --dims distintos haya en la lista de jobs.
    if jobs is not None:
        single = len(jobs) == 1
        audio_and_dims = [(j["file"], j.get("dims")) for j in jobs]
    else:
        single = len(args["audio_paths"]) == 1
        audio_and_dims = [(p, args["dims"]) for p in args["audio_paths"]]

    results = []
    for audio_path, dims in audio_and_dims:
        started = time.time()
        try:
            result = score_one(model, processor, audio_path, actual_device, dims=dims)
        except Exception as e:
            result = {"error": str(e)}
        result["file"] = audio_path
        result["elapsed_ms"] = int((time.time() - started) * 1000)
        result["model"] = args["model_id"]
        result["device"] = actual_device
        results.append(result)

    # Output JSON. --jobs-stdin siempre devuelve forma batch (el caller —
    # runClapScoreJobs en Node— siempre espera results[], nunca el objeto
    # único de compatibilidad de 1 solo archivo del modo CLI clásico).
    if single and jobs is None:
        out = results[0]
        print(json.dumps(out, ensure_ascii=False))
        if "error" in out and "clap_score" not in out:
            sys.exit(1)
    else:
        print(json.dumps({"batch": True, "results": results}, ensure_ascii=False))
        # exit 0 aunque un archivo individual falle — el error viene por archivo


if __name__ == "__main__":
    main()
