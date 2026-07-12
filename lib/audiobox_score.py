#!/usr/bin/env python3
# lib/audiobox_score.py — Calidad de producción musical con Meta Audiobox
# Aesthetics (facebookresearch/audiobox-aesthetics). 100% local, cero API de
# nube. Devuelve JSON.
#
# Predice 4 ejes (~1-10 cada uno):
#   PQ = Production Quality   (el titular para este pipeline)
#   PC = Production Complexity
#   CE = Content Enjoyment
#   CU = Content Usefulness
# Se reportan los 4 — calibración gratis, PQ es el que se mira primero.
#
# Uso: python audiobox_score.py <audio...> [--device cuda|cpu]
#   - Positionals que terminan en .mp3/.wav/.m4a/.flac/.ogg son audios.
#   - Con VARIOS audios el modelo se carga UNA sola vez (mismo patrón que
#     clap_score.py / nisqa_score.py / muq_eval_score.py).
#   - Sin --device: el paquete decide solo (usa CUDA si está). El flag existe
#     por consistencia con los otros scripts; el fallback CUDA→CPU lo maneja
#     el propio paquete.
#
# Output (stdout, una sola línea JSON):
#   - 1 audio  → objeto único.  N audios → { "batch": true, "results": [...] }.
#   Cada resultado: pq, pc, ce, cu, file, elapsed_ms, model, device.
#   Error global → {"error": "..."} y exit 1.
#
# Instalación:
#   pip install audiobox_aesthetics
#   (torch ya está por Whisper. El checkpoint se auto-descarga la 1ª corrida.)

import sys
import json
import time
import os
import warnings

warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)
os.environ["TOKENIZERS_PARALLELISM"] = "false"

AUDIO_EXTENSIONS = (".mp3", ".wav", ".m4a", ".flac", ".ogg")


def parse_args(argv):
    args = {"audio_paths": [], "device": None}
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


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: python audiobox_score.py <audio...> [--device cuda|cpu]"}))
        sys.exit(1)

    args = parse_args(sys.argv[1:])
    if not args["audio_paths"]:
        print(json.dumps({"error": "No se pasó ningún archivo de audio (.mp3/.wav/.m4a/.flac/.ogg)."}))
        sys.exit(1)

    # Fail-fast: verificar dependencias antes de cargar nada pesado
    try:
        from audiobox_aesthetics.infer import initialize_predictor  # noqa: F401
    except ImportError:
        print(json.dumps({
            "error": "Dependencia faltante: audiobox_aesthetics. Corrí: pip install audiobox_aesthetics"
        }))
        sys.exit(1)

    for ap in args["audio_paths"]:
        if not os.path.isfile(ap):
            print(json.dumps({"error": f"Archivo no encontrado: {ap}"}))
            sys.exit(1)

    load_start = time.time()
    try:
        predictor = initialize_predictor()
    except Exception as e:
        print(json.dumps({"error": f"Error cargando Audiobox Aesthetics: {e}"}))
        sys.exit(1)
    print(f"   Audiobox modelo cargado en {int((time.time() - load_start) * 1000)}ms", file=sys.stderr)

    device = "cuda"
    try:
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        device = "unknown"

    results = []
    for audio_path in args["audio_paths"]:
        started = time.time()
        try:
            # predictor.forward acepta batch, pero se llama por archivo para
            # que un MP3 corrupto no tire el resultado del otro (el modelo ya
            # quedó cargado — el costo por archivo extra es mínimo).
            raw = predictor.forward([{"path": audio_path}])
            scores = raw[0] if isinstance(raw, list) else raw
            if isinstance(scores, str):
                scores = json.loads(scores)
            result = {
                "pq": round(float(scores["PQ"]), 2),
                "pc": round(float(scores["PC"]), 2),
                "ce": round(float(scores["CE"]), 2),
                "cu": round(float(scores["CU"]), 2),
            }
        except Exception as e:
            result = {"error": str(e)}
        result["file"] = audio_path
        result["elapsed_ms"] = int((time.time() - started) * 1000)
        result["model"] = "facebook/audiobox-aesthetics"
        result["device"] = device
        results.append(result)

    if len(results) == 1:
        out = results[0]
        print(json.dumps(out, ensure_ascii=False))
        if "error" in out and "pq" not in out:
            sys.exit(1)
    else:
        print(json.dumps({"batch": True, "results": results}, ensure_ascii=False))
        # exit 0 aunque un archivo individual falle — el error viene por archivo


if __name__ == "__main__":
    main()
