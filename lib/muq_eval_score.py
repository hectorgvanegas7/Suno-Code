#!/usr/bin/env python3
# lib/muq_eval_score.py — Calidad musical percibida con MuQ-Eval (arXiv
# 2603.22677): head liviano (attention pooling + MLP) sobre el encoder
# MuQ-310M congelado, entrenado en MusicEval contra ratings de expertos.
# 100% local, cero API de nube. Devuelve JSON.
#
# OJO calibración: el SRCC 0.957 del paper es a nivel SISTEMA; por clip
# individual (como lo usa este pipeline) es 0.838 — muy bueno, no mágico.
#
# Uso: python muq_eval_score.py <audio...> [--device cuda|cpu]
#   - Positionals que terminan en .mp3/.wav/.m4a/.flac/.ogg son audios.
#   - Con VARIOS audios el modelo se carga UNA sola vez (mismo patrón que
#     clap_score.py / nisqa_score.py).
#   - Sin --device: cpu (seguro). Con --device cuda: intenta CUDA y si falla,
#     reintenta automáticamente en CPU (warning a stderr, JSON limpio a stdout).
#
# Output (stdout, una sola línea JSON):
#   - 1 audio  → objeto único.  N audios → { "batch": true, "results": [...] }.
#   Cada resultado: score (1-5, media de las ventanas), score_std, n_clips,
#   file, elapsed_ms, model, device. Error global → {"error": "..."} exit 1.
#
# Estrategia: MuQ-Eval evalúa clips de 10s a 24kHz (240000 samples). La
# canción entera se trocea en ventanas consecutivas de 10s (la última se
# descarta si quedó < 5s), se puntúa cada una y se reporta media + desvío —
# el desvío es gratis y delata canciones con tramos malos.
#
# Instalación (MuQ-Eval NO es pip-instalable — es un repo clonado):
#   git clone https://github.com/dgtql/MuQ-Eval  (a cualquier carpeta)
#   pip install -r MuQ-Eval/requirements.txt     (torch/librosa ya están)
#   setx MUQ_EVAL_DIR "C:\ruta\a\MuQ-Eval"
#   Los checkpoints (config.yaml + model_state_dict.pt del head A1, y el
#   encoder MuQ-310M) se auto-descargan de HuggingFace en la primera corrida.

import sys
import json
import time
import os
import warnings

warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)
os.environ["TOKENIZERS_PARALLELISM"] = "false"

AUDIO_EXTENSIONS = (".mp3", ".wav", ".m4a", ".flac", ".ogg")

HF_REPO = "zhudi2825/MuQ-Eval-A1"  # head A1 (Frozen+MSE), el recomendado del paper
TARGET_SR = 24000
CLIP_SAMPLES = 240000  # 10s a 24kHz — largo fijo que espera MuQ-Eval
MIN_TAIL_SAMPLES = TARGET_SR * 5  # última ventana < 5s se descarta (mitad relleno)


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
            i += 1  # forward-compatible
    return args


def find_muq_eval_dir():
    """Ubica el clon del repo MuQ-Eval. Prioridad: env MUQ_EVAL_DIR, después
    carpetas hermanas obvias del repo. Devuelve path o None."""
    candidates = []
    env_dir = os.environ.get("MUQ_EVAL_DIR")
    if env_dir:
        candidates.append(env_dir)
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    candidates.append(os.path.join(os.path.dirname(repo_root), "MuQ-Eval"))
    candidates.append(os.path.join(repo_root, "MuQ-Eval"))
    for c in candidates:
        if c and os.path.isfile(os.path.join(c, "src", "model.py")):
            return c
    return None


def load_model(device):
    """Carga el head A1 desde HF hub usando las clases del repo MuQ-Eval
    (src.model.MusicQualityModel — el repo no es pip-instalable, se importa
    desde el clon vía sys.path). Fallback CUDA→CPU automático.
    Devuelve (model, actual_device)."""
    import torch
    from huggingface_hub import hf_hub_download
    from omegaconf import OmegaConf
    from src.model import MusicQualityModel

    config_path = hf_hub_download(HF_REPO, "config.yaml")
    model_path = hf_hub_download(HF_REPO, "model_state_dict.pt")

    cfg = OmegaConf.load(config_path)
    model = MusicQualityModel(cfg)
    model.load_state_dict(torch.load(model_path, map_location="cpu", weights_only=False))
    model.eval()

    if device == "cuda":
        try:
            if not torch.cuda.is_available():
                raise RuntimeError("CUDA no disponible en este sistema")
            model = model.to("cuda")
            print(f"✅ MuQ-Eval cargado en CUDA ({torch.cuda.get_device_name(0)})", file=sys.stderr)
            return model, "cuda"
        except Exception as e:
            print(f"⚠️  CUDA no disponible/falló para MuQ-Eval ({e}), usando CPU.", file=sys.stderr)
            return model.cpu(), "cpu"
    return model, "cpu"


def load_audio_windows(audio_path):
    """Carga el audio a 24kHz mono y lo trocea en ventanas consecutivas de
    CLIP_SAMPLES. La última ventana se rellena con ceros si le falta poco, o
    se descarta si quedó demasiado corta (< MIN_TAIL_SAMPLES). Devuelve
    (lista de np.array de largo CLIP_SAMPLES, duración en segundos)."""
    import librosa
    import numpy as np

    audio, sr = librosa.load(audio_path, sr=TARGET_SR, mono=True)
    duration_sec = len(audio) / sr

    windows = []
    for start in range(0, len(audio), CLIP_SAMPLES):
        chunk = audio[start : start + CLIP_SAMPLES]
        if len(chunk) < CLIP_SAMPLES:
            if len(chunk) < MIN_TAIL_SAMPLES and windows:
                break  # cola demasiado corta y ya hay ventanas completas
            chunk = np.pad(chunk, (0, CLIP_SAMPLES - len(chunk)))
        windows.append(chunk)

    if not windows:
        windows = [np.pad(audio, (0, CLIP_SAMPLES - len(audio)))]
    return windows, duration_sec


def score_one(model, audio_path, device):
    """Puntúa un archivo: media + desvío del score MI (Musical Impression,
    1-5) sobre todas las ventanas de 10s. Devuelve dict o lanza."""
    import torch
    import numpy as np

    windows, duration_sec = load_audio_windows(audio_path)

    scores = []
    with torch.no_grad():
        for chunk in windows:
            waveform = torch.from_numpy(chunk).float().unsqueeze(0)  # (1, CLIP_SAMPLES)
            if device == "cuda":
                waveform = waveform.to("cuda")
            out = model(waveform)
            # El head A1 devuelve un dict de heads → score. "MI" (Musical
            # Impression) es el titular del paper; si el checkpoint trae otro
            # nombre de head, usamos el primero en vez de fallar.
            if isinstance(out, dict):
                head = out.get("MI", next(iter(out.values())))
            else:
                head = out
            value = head.item() if hasattr(head, "item") else float(head)
            scores.append(float(value))

    mean = float(np.mean(scores))
    std = float(np.std(scores))
    return {
        "score": round(max(1.0, min(5.0, mean)), 2),
        "score_std": round(std, 2),
        "n_clips": len(scores),
        "duration_seconds": round(duration_sec, 1),
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: python muq_eval_score.py <audio...> [--device cuda|cpu]"}))
        sys.exit(1)

    args = parse_args(sys.argv[1:])
    if not args["audio_paths"]:
        print(json.dumps({"error": "No se pasó ningún archivo de audio (.mp3/.wav/.m4a/.flac/.ogg)."}))
        sys.exit(1)

    # El repo MuQ-Eval no es pip-instalable: hay que tener el clon y sumarlo
    # a sys.path ANTES del fail-fast de imports.
    muq_dir = find_muq_eval_dir()
    if not muq_dir:
        print(json.dumps({
            "error": "Repo MuQ-Eval no encontrado. Cloná https://github.com/dgtql/MuQ-Eval "
            "y seteá MUQ_EVAL_DIR a esa carpeta (setx MUQ_EVAL_DIR \"C:\\ruta\\a\\MuQ-Eval\")."
        }))
        sys.exit(1)
    sys.path.insert(0, muq_dir)

    # Fail-fast: verificar dependencias antes de cargar nada pesado
    missing = []
    for mod, pip_name in [("torch", "torch"), ("librosa", "librosa"),
                          ("huggingface_hub", "huggingface_hub"), ("omegaconf", "omegaconf")]:
        try:
            __import__(mod)
        except ImportError:
            missing.append(pip_name)
    if missing:
        print(json.dumps({
            "error": f"Dependencias faltantes: {', '.join(missing)}. "
            f"Corrí: pip install -r {os.path.join(muq_dir, 'requirements.txt')}"
        }))
        sys.exit(1)

    for ap in args["audio_paths"]:
        if not os.path.isfile(ap):
            print(json.dumps({"error": f"Archivo no encontrado: {ap}"}))
            sys.exit(1)

    load_start = time.time()
    try:
        model, actual_device = load_model(args["device"])
    except Exception as e:
        print(json.dumps({"error": f"Error cargando MuQ-Eval: {e}"}))
        sys.exit(1)
    print(f"   MuQ-Eval modelo cargado en {int((time.time() - load_start) * 1000)}ms", file=sys.stderr)

    results = []
    for audio_path in args["audio_paths"]:
        started = time.time()
        try:
            result = score_one(model, audio_path, actual_device)
        except Exception as e:
            result = {"error": str(e)}
        result["file"] = audio_path
        result["elapsed_ms"] = int((time.time() - started) * 1000)
        result["model"] = HF_REPO
        result["device"] = actual_device
        results.append(result)

    if len(results) == 1:
        out = results[0]
        print(json.dumps(out, ensure_ascii=False))
        if "error" in out and "score" not in out:
            sys.exit(1)
    else:
        print(json.dumps({"batch": True, "results": results}, ensure_ascii=False))
        # exit 0 aunque un archivo individual falle — el error viene por archivo


if __name__ == "__main__":
    main()
