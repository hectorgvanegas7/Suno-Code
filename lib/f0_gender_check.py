#!/usr/bin/env python3
# lib/f0_gender_check.py — Estima el F0 (frecuencia fundamental) del audio y
# lo compara contra el rango típico de voz masculina/femenina cantada. 100%
# local, CPU (librosa.pyin, sin GPU ni modelo pre-entrenado nuevo).
#
# Uso: python f0_gender_check.py <audio...>
#   - 1 audio  → objeto único (backward-compatible con callers de 1 archivo).
#   - N audios → { "batch": true, "results": [{ ... }] }.
#
# Output (stdout, una sola línea JSON) por archivo:
#   median_f0_hz:     mediana de F0 en frames sonoros (voiced), o null si no
#                     se detectó voz sonora suficiente.
#   voiced_ratio:     fracción de frames clasificados como voz sonora (0-1).
#   detected_gender:  "Masculina" | "Femenina" | "Indeterminado"
#                     (rangos de referencia para voz CANTADA, más amplios que
#                     habla conversacional — femenina >= 175 Hz, masculina
#                     <= 160 Hz, zona 160-175 Hz ambigua a propósito).
#
# INFORMATIVO — no calibrado contra casos reales de Suno todavía (ver
# LESSONS.md, filosofía del repo: ninguna señal nueva decide sola sin
# validarla en vivo primero). pickBestVersion NO usa esto para puntuar; solo
# se imprime como referencia y queda en el reporte para revisión manual si el
# género detectado no coincide con "voz" en song.txt.
#
# Instalación: librosa ya es requisito de clap_score.py (pip install librosa).

import sys
import json
import warnings

warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)

FEMALE_FLOOR_HZ = 175.0
MALE_CEILING_HZ = 160.0
FMIN_HZ = 65.0   # por debajo de la voz masculina más grave cantando
FMAX_HZ = 500.0  # por encima de la voz femenina más aguda cantando


def classify_gender(median_f0):
    if median_f0 is None:
        return "Indeterminado"
    if median_f0 >= FEMALE_FLOOR_HZ:
        return "Femenina"
    if median_f0 <= MALE_CEILING_HZ:
        return "Masculina"
    return "Indeterminado"


def analyze_one(path):
    import numpy as np
    import librosa

    y, sr = librosa.load(path, sr=16000, mono=True)
    f0, voiced_flag, _voiced_probs = librosa.pyin(
        y, fmin=FMIN_HZ, fmax=FMAX_HZ, sr=sr
    )
    voiced_ratio = float(np.mean(voiced_flag)) if len(voiced_flag) > 0 else 0.0
    voiced_f0 = f0[voiced_flag] if voiced_flag is not None else np.array([])
    voiced_f0 = voiced_f0[~np.isnan(voiced_f0)]

    median_f0 = float(np.median(voiced_f0)) if voiced_f0.size >= 10 else None
    return {
        "file": path,
        "median_f0_hz": round(median_f0, 1) if median_f0 is not None else None,
        "voiced_ratio": round(voiced_ratio, 3),
        "detected_gender": classify_gender(median_f0),
    }


def main():
    paths = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not paths:
        print(json.dumps({"error": "Uso: python f0_gender_check.py <audio...>"}))
        sys.exit(1)

    results = []
    for p in paths:
        try:
            results.append(analyze_one(p))
        except Exception as e:
            results.append({"file": p, "error": str(e)})

    if len(results) == 1:
        print(json.dumps(results[0]))
    else:
        print(json.dumps({"batch": True, "results": results}))


if __name__ == "__main__":
    main()
