#!/usr/bin/env python3
# lib/transcribe.py — Transcribe un MP3 con faster-whisper y devuelve JSON.
#
# Uso: python transcribe.py <audio_path> [model_size] [--device cuda|cpu] [--initial-prompt TEXT]
#   - Sin --device: cpu/int8 (comportamiento de siempre, usado sin --demucs).
#   - Con --device cuda: intenta cuda/float16 (RTX 4070) y si CUDA no está
#     disponible o falla, reintenta automáticamente en cpu/int8 (loguea warning
#     a stderr, el JSON de stdout no se ensucia).
#
# Output: JSON a stdout con { "segments": [...], "text": "..." }. Cada segmento
# incluye ahora "words": [{word, start, end, probability}] cuando el modelo los
# provee (faster-whisper con word_timestamps=True).
# Si falla, imprime {"error": "mensaje"} y sale con código 1.
#
# Instalación (ver también LESSONS.md):
#   pip install faster-whisper
#   pip install torch --index-url https://download.pytorch.org/whl/cu124
#   pip install torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
#   pip install soundfile   (backend que necesita torchaudio en Windows)
#   pip install demucs      (opcional, solo para --demucs en verify-audio.js)

import sys
import json


def parse_args(argv):
    args = {"audio_path": None, "model_size": "small", "device": "cpu", "initial_prompt": None}
    positional = []
    i = 0
    while i < len(argv):
        if argv[i] == "--device" and i + 1 < len(argv):
            args["device"] = argv[i + 1]
            i += 2
        elif argv[i] == "--initial-prompt" and i + 1 < len(argv):
            args["initial_prompt"] = argv[i + 1]
            i += 2
        else:
            positional.append(argv[i])
            i += 1
    if len(positional) >= 1:
        args["audio_path"] = positional[0]
    if len(positional) >= 2:
        args["model_size"] = positional[1]
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


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: python transcribe.py <audio_path> [model_size] [--device cuda|cpu] [--initial-prompt TEXT]"}))
        sys.exit(1)

    args = parse_args(sys.argv[1:])
    audio_path = args["audio_path"]
    model_size = args["model_size"]

    try:
        from faster_whisper import WhisperModel  # noqa: F401  (fail fast si no está instalado)
    except ImportError:
        print(json.dumps({"error": "faster-whisper no instalado. Corrí: pip install faster-whisper"}))
        sys.exit(1)

    try:
        model, actual_device = load_model(model_size, args["device"])

        segments_iter, info = model.transcribe(
            audio_path,
            language="es",
            beam_size=5,
            vad_filter=True,
            word_timestamps=True,
            initial_prompt=args["initial_prompt"] or None,
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

        result = {
            "text": " ".join(full_text_parts),
            "segments": segments,
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
            "model": model_size,
            "device": actual_device,
        }
        print(json.dumps(result, ensure_ascii=False))

    except FileNotFoundError:
        print(json.dumps({"error": f"Archivo no encontrado: {audio_path}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
