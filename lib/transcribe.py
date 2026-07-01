#!/usr/bin/env python3
# lib/transcribe.py — Transcribe un MP3 con faster-whisper y devuelve JSON.
# Uso: python transcribe.py <audio_path> [model_size]
# Output: JSON a stdout con { "segments": [...], "text": "..." }
# Si falla, imprime {"error": "mensaje"} y sale con código 1.

import sys
import json

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: python transcribe.py <audio_path> [model_size]"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "small"

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"error": "faster-whisper no instalado. Corrí: pip install faster-whisper"}))
        sys.exit(1)

    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments_iter, info = model.transcribe(
            audio_path,
            language="es",
            beam_size=5,
            vad_filter=True,
        )

        segments = []
        full_text_parts = []
        for seg in segments_iter:
            segments.append({
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": seg.text.strip(),
            })
            full_text_parts.append(seg.text.strip())

        result = {
            "text": " ".join(full_text_parts),
            "segments": segments,
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
            "model": model_size,
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
