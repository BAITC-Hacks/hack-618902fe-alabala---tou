"""Offline Kazakh/Russian speech-to-text helper.

First use downloads the model files from Hugging Face; after that, inference can
run offline using the local Hugging Face cache.

See README.md for the GPU installation instructions.

Example:
    from stt_kazakh_russian import transcribe

    text = transcribe("meeting.wav")
    print(text)
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Union

import librosa
import numpy as np
import soundfile as sf
import torch
from huggingface_hub import hf_hub_download


MODEL_REPO = "alibiserikbay/kazakh-russian-mixed-stt"
MODEL_VARIANT = "rukk"  # "rukk" = mixed Kazakh/Russian, "kk" = Kazakh, "ru" = Russian


def _get_device() -> torch.device:
    name = os.environ.get("STT_DEVICE", "cuda").lower()
    if name not in {"cuda", "cpu"}:
        raise ValueError("STT_DEVICE must be 'cuda' or 'cpu'")
    if name == "cuda" and not torch.cuda.is_available():
        raise RuntimeError(
            f"CUDA is unavailable in PyTorch {torch.__version__} "
            f"(built with CUDA: {torch.version.cuda}). "
            "Install a CUDA-enabled PyTorch build and check that the NVIDIA driver "
            "is working. See README.md. To run on the CPU, set STT_DEVICE=cpu."
        )
    return torch.device(name)


_DEVICE = _get_device()


def _load_model():
    model_path = hf_hub_download(MODEL_REPO, f"asr/{MODEL_VARIANT}/model.pt")
    tokens_path = hf_hub_download(MODEL_REPO, f"asr/{MODEL_VARIANT}/tokens.lst")

    model = torch.jit.load(model_path, map_location=_DEVICE).eval()
    tokens: dict[int, str] = {}
    with open(tokens_path, encoding="utf-8") as token_file:
        for line in token_file:
            if line.strip():
                symbol, index = line.rstrip("\n").split("\t")
                tokens[int(index)] = symbol

    return model, tokens, max(tokens) + 1  # CTC blank token is the final index


_MODEL, _TOKENS, _BLANK = _load_model()


def transcribe(audio_path: Union[str, Path]) -> str:
    """Transcribe an audio file and return its text.

    Supports audio formats readable by SoundFile (for example WAV and FLAC).
    Audio is converted to mono, 16 kHz, as required by the model.
    """
    wav, sample_rate = sf.read(str(audio_path), dtype="float32")

    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    if sample_rate != 16000:
        wav = librosa.resample(wav, orig_sr=sample_rate, target_sr=16000)
    wav = np.asarray(wav, dtype=np.float32)

    with torch.inference_mode():
        audio = torch.from_numpy(wav).unsqueeze(0).to(_DEVICE)
        logits = _MODEL(audio)[0]

    token_ids = logits[0].argmax(-1).tolist()
    output_tokens: list[str] = []
    previous = None
    for token_id in token_ids:
        if token_id != previous and token_id != _BLANK:
            output_tokens.append(_TOKENS.get(token_id, ""))
        previous = token_id

    text = "".join(output_tokens).replace("|", " ").replace("_", " ")
    return re.sub(r"\s+", " ", text).strip()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Transcribe Kazakh/Russian audio offline")
    parser.add_argument("audio", help="Path to an audio file, e.g. recording.wav")
    args = parser.parse_args()
    print(transcribe(args.audio))
