#!/usr/bin/env python3
# lib/nisqa_score.py — Evalúa naturalidad/calidad de voz con NISQA v2.0
# (Non-Intrusive Speech Quality Assessment) vía torchmetrics. 100% local.
#
# Uso: python nisqa_score.py <audio...> [--device cuda|cpu]
#   - Positionals que terminan en .mp3/.wav/.m4a/.flac/.ogg son audios.
#   - Con VARIOS audios el modelo se carga UNA sola vez (mismo patrón que
#     clap_score.py/transcribe.py).
#   - Sin --device: cpu (seguro). Con --device cuda: intenta CUDA y si falla,
#     reintenta automáticamente en CPU (warning a stderr, JSON limpio a stdout).
#
# Output (stdout, una sola línea JSON):
#   - 1 audio  → objeto único (backward-compatible con callers de 1 archivo).
#   - N audios → { "batch": true, "results": [{ ... }] }.
#   Cada resultado incluye:
#     nisqa_score: 0-100 (MOS normalizado: round((mos-1)/4*100))
#     mos:         1.0-5.0 crudo, para referencia humana
#     dimensions:  { noisiness, discontinuity, coloration, loudness } normalizadas 0-100
#     model, device, duration_seconds
#   Si falla globalmente, imprime {"error": "mensaje"} y sale con código 1.
#
# A diferencia de CLAP (similitud texto-audio con prompts antónimos), NISQA es
# un modelo entrenado específicamente para predecir MOS de voz — más preciso
# para detectar si una voz generada suena artificial/con artefactos. Señal
# complementaria a CLAP, no lo reemplaza (CLAP sigue cubriendo producción/
# emoción/final, que NISQA no mide).
#
# Instalación:
#   pip install torchmetrics
#   (torch y librosa ya deberían estar instalados para Whisper/CLAP/demucs)

import sys
import json
import time
import os
import warnings

warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)
os.environ["TOKENIZERS_PARALLELISM"] = "false"

AUDIO_EXTENSIONS = (".mp3", ".wav", ".m4a", ".flac", ".ogg")
TARGET_SR = 48000  # NISQA v2.0 espera 48kHz (mismo TARGET_SR que clap_score.py)

# Orden fijo de salida de torchmetrics: mos, noisiness, discontinuity,
# coloration, loudness (ver docs de NonIntrusiveSpeechQualityAssessment).
DIM_NAMES = ["noisiness", "discontinuity", "coloration", "loudness"]


def parse_args(argv):
    args = {"audio_paths": [], "device": "cpu"}
    i = 0
    while i < len(argv):
        if argv[i] == "--device" and i + 1 < len(argv):
            args["device"] = argv[i + 1]
            i += 2
        elif argv[i].lower().endswith(AUDIO_EXTENSIONS):
            args["audio_paths"].append(argv[i])
            i += 1
        else:
            # Argumento desconocido — ignorar (forward-compatible)
            i += 1
    return args


def load_metric(device):
    """Carga el metric NISQA de torchmetrics. Fallback CUDA→CPU automático."""
    import torch
    from torchmetrics.audio import NonIntrusiveSpeechQualityAssessment

    if device == "cuda":
        try:
            if not torch.cuda.is_available():
                raise RuntimeError("CUDA no disponible en este sistema")
            metric = NonIntrusiveSpeechQualityAssessment(TARGET_SR).to("cuda")
            print(
                f"✅ NISQA cargado en CUDA ({torch.cuda.get_device_name(0)})",
                file=sys.stderr,
            )
            return metric, "cuda"
        except Exception as e:
            print(
                f"⚠️  CUDA no disponible/falló para NISQA ({e}), usando CPU.",
                file=sys.stderr,
            )
            metric = NonIntrusiveSpeechQualityAssessment(TARGET_SR)
            return metric, "cpu"
    else:
        metric = NonIntrusiveSpeechQualityAssessment(TARGET_SR)
        return metric, "cpu"


def normalize_1_5_to_100(x):
    return round(max(0.0, min(100.0, (x - 1.0) / 4.0 * 100.0)))


def score_one(metric, audio_path, device):
    """Evalúa un archivo de audio. Devuelve dict con scores o lanza."""
    import torch
    import librosa

    audio, sr = librosa.load(audio_path, sr=TARGET_SR, mono=True)
    duration_sec = len(audio) / sr

    preds = torch.from_numpy(audio).float()
    if device == "cuda":
        preds = preds.to("cuda")

    with torch.no_grad():
        out = metric(preds)

    values = out.detach().cpu().numpy().tolist()
    mos = float(values[0])
    dim_values = values[1:5]
    dimensions = {name: normalize_1_5_to_100(v) for name, v in zip(DIM_NAMES, dim_values)}

    return {
        "nisqa_score": normalize_1_5_to_100(mos),
        "mos": round(mos, 2),
        "dimensions": dimensions,
        "duration_seconds": round(duration_sec, 1),
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: python nisqa_score.py <audio...> [--device cuda|cpu]"}))
        sys.exit(1)

    args = parse_args(sys.argv[1:])

    if not args["audio_paths"]:
        print(json.dumps({"error": "No se pasó ningún archivo de audio (.mp3/.wav/.m4a/.flac/.ogg)."}))
        sys.exit(1)

    # Fail-fast: verificar dependencias antes de cargar nada pesado
    missing = []
    try:
        import torchmetrics  # noqa: F401
    except ImportError:
        missing.append("torchmetrics")
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

    for ap in args["audio_paths"]:
        if not os.path.isfile(ap):
            print(json.dumps({"error": f"Archivo no encontrado: {ap}"}))
            sys.exit(1)

    load_start = time.time()
    try:
        metric, actual_device = load_metric(args["device"])
    except Exception as e:
        print(json.dumps({"error": f"Error cargando modelo NISQA: {e}"}))
        sys.exit(1)
    load_ms = int((time.time() - load_start) * 1000)
    print(f"   NISQA modelo cargado en {load_ms}ms", file=sys.stderr)

    single = len(args["audio_paths"]) == 1
    results = []
    for audio_path in args["audio_paths"]:
        started = time.time()
        try:
            result = score_one(metric, audio_path, actual_device)
        except Exception as e:
            result = {"error": str(e)}
        result["file"] = audio_path
        result["elapsed_ms"] = int((time.time() - started) * 1000)
        result["model"] = "torchmetrics-nisqa-v2"
        result["device"] = actual_device
        results.append(result)

    if single:
        out = results[0]
        print(json.dumps(out, ensure_ascii=False))
        if "error" in out and "nisqa_score" not in out:
            sys.exit(1)
    else:
        print(json.dumps({"batch": True, "results": results}, ensure_ascii=False))
        # exit 0 aunque un archivo individual falle — el error viene por archivo


if __name__ == "__main__":
    main()
