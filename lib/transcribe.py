#!/usr/bin/env python3
# lib/transcribe.py — Transcribe uno o más audios con faster-whisper y devuelve JSON.
#
# Uso: python transcribe.py <audio...> [model_size] [--device cuda|cpu] [--initial-prompt TEXT]
#   - Positionals que terminan en .mp3/.wav/.m4a/.flac/.ogg son audios; cualquier
#     otro positional es el model_size (backward compatible con la firma vieja
#     de un solo archivo).
#   - Con VARIOS audios el modelo se carga UNA sola vez (cargar large-v3 en CUDA
#     tarda decenas de segundos — batchear A y B ahorra esa carga duplicada).
#   - Sin --device: cpu/int8 (comportamiento de siempre, usado sin --demucs).
#   - Con --device cuda: intenta cuda/float16 (RTX 4070) y si CUDA no está
#     disponible o falla, reintenta automáticamente en cpu/int8 (loguea warning
#     a stderr, el JSON de stdout no se ensucia).
#
# Output (stdout, una sola línea JSON):
#   - 1 audio  → objeto único { "segments": [...], "text": "...", ... } (formato
#     histórico, para no romper callers existentes).
#   - N audios → { "batch": true, "results": [{ "file": ..., "elapsed_ms": ...,
#     ...mismo formato por archivo, o "error" por archivo }] }.
# Cada segmento incluye "words": [{word, start, end, probability}] cuando el
# modelo los provee (word_timestamps=True).
# Si falla globalmente, imprime {"error": "mensaje"} y sale con código 1.
#
# Instalación (ver también LESSONS.md):
#   pip install faster-whisper
#   pip install torch --index-url https://download.pytorch.org/whl/cu124
#   pip install torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
#   pip install soundfile   (backend que necesita torchaudio en Windows)
#   pip install demucs      (opcional, solo para --demucs en verify-audio.js)

import sys
import json
import time

AUDIO_EXTENSIONS = (".mp3", ".wav", ".m4a", ".flac", ".ogg")


def parse_args(argv):
    args = {"audio_paths": [], "model_size": "small", "device": "cpu", "initial_prompt": None}
    i = 0
    while i < len(argv):
        if argv[i] == "--device" and i + 1 < len(argv):
            args["device"] = argv[i + 1]
            i += 2
        elif argv[i] == "--initial-prompt" and i + 1 < len(argv):
            args["initial_prompt"] = argv[i + 1]
            i += 2
        elif argv[i].lower().endswith(AUDIO_EXTENSIONS):
            args["audio_paths"].append(argv[i])
            i += 1
        else:
            # positional que no es audio = model_size (firma histórica)
            args["model_size"] = argv[i]
            i += 1
    return args


def load_model(model_size, device):
    from faster_whisper import WhisperModel

    if device == "cuda":
        try:
            return WhisperModel(model_size, device="cuda", compute_type="float16"), "cuda"
        except Exception as e:
            print(f"⚠️  CUDA no disponible/falló ({e}), usando CPU int8.", file=sys.stderr)
            return WhisperModel(model_size, device="cpu", compute_type="int8"), "cpu"
    return WhisperModel(model_size, device="cpu", compute_type="int8"), "cpu"


def transcribe_one(model, actual_device, audio_path, model_size, initial_prompt):
    segments_iter, info = model.transcribe(
        audio_path,
        language="es",
        beam_size=5,
        vad_filter=True,
        word_timestamps=True,
        condition_on_previous_text=False,
        initial_prompt=initial_prompt or None,
    )

    segments = []
    full_text_parts = []
    for seg in segments_iter:
        words = None
        if seg.words:
            words = [
                {
                    "word": w.word.strip(),
                    "start": round(w.start, 2),
                    "end": round(w.end, 2),
                    "probability": round(w.probability, 3),
                }
                for w in seg.words
            ]
        segment = {
            "start": round(seg.start, 2),
            "end": round(seg.end, 2),
            "text": seg.text.strip(),
        }
        if words:
            segment["words"] = words
        segments.append(segment)
        full_text_parts.append(seg.text.strip())

    return {
        "text": " ".join(full_text_parts),
        "segments": segments,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "model": model_size,
        "device": actual_device,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: python transcribe.py <audio...> [model_size] [--device cuda|cpu] [--initial-prompt TEXT]"}))
        sys.exit(1)

    args = parse_args(sys.argv[1:])
    if not args["audio_paths"]:
        print(json.dumps({"error": "No se pasó ningún archivo de audio (.mp3/.wav/.m4a/.flac/.ogg)."}))
        sys.exit(1)

    model_size = args["model_size"]

    try:
        from faster_whisper import WhisperModel  # noqa: F401  (fail fast si no está instalado)
    except ImportError:
        print(json.dumps({"error": "faster-whisper no instalado. Corrí: pip install faster-whisper"}))
        sys.exit(1)

    try:
        model, actual_device = load_model(model_size, args["device"])
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    single = len(args["audio_paths"]) == 1
    results = []
    for audio_path in args["audio_paths"]:
        started = time.time()
        try:
            result = transcribe_one(model, actual_device, audio_path, model_size, args["initial_prompt"])
        except FileNotFoundError:
            result = {"error": f"Archivo no encontrado: {audio_path}"}
        except Exception as e:
            result = {"error": str(e)}
        result["file"] = audio_path
        result["elapsed_ms"] = int((time.time() - started) * 1000)
        results.append(result)

    if single:
        # Formato histórico: objeto único, exit 1 si falló.
        out = results[0]
        print(json.dumps(out, ensure_ascii=False))
        if "error" in out and "text" not in out:
            sys.exit(1)
    else:
        print(json.dumps({"batch": True, "results": results}, ensure_ascii=False))
        # exit 0 aunque un archivo individual falle — el error viene por archivo.


if __name__ == "__main__":
    main()
