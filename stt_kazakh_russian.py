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
import gc
import logging
import math
from functools import lru_cache
from pathlib import Path
from threading import Lock
from typing import Callable, Union

import librosa
import numpy as np
import soundfile as sf
import torch
from huggingface_hub import hf_hub_download


MODEL_REPO = "alibiserikbay/kazakh-russian-mixed-stt"
MODEL_VARIANT = "rukk"  # "rukk" = mixed Kazakh/Russian, "kk" = Kazakh, "ru" = Russian
SAMPLE_RATE = 16000
_LOGGER = logging.getLogger(__name__)
_TRANSCRIBE_LOCK = Lock()  # Concurrent requests must not multiply GPU activations.


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


@lru_cache(maxsize=1)
def _load_model(device: torch.device):
    model_path = hf_hub_download(MODEL_REPO, f"asr/{MODEL_VARIANT}/model.pt")
    tokens_path = hf_hub_download(MODEL_REPO, f"asr/{MODEL_VARIANT}/tokens.lst")

    model = torch.jit.load(model_path, map_location=device).eval()
    tokens: dict[int, str] = {}
    with open(tokens_path, encoding="utf-8") as token_file:
        for line in token_file:
            if line.strip():
                symbol, index = line.rstrip("\n").split("\t")
                tokens[int(index)] = symbol

    return model, tokens, max(tokens) + 1  # CTC blank token is the final index


def _predict_ids(model, wav: np.ndarray, device: torch.device) -> list[int]:
    # Keep all GPU tensors in this frame, so even an OOM can release them before
    # retrying. Only the small list of token IDs leaves the function.
    with torch.inference_mode():
        audio = torch.from_numpy(wav).unsqueeze(0).to(device)
        logits = model(audio)[0]
        return logits[0].argmax(-1).cpu().tolist()


def _is_cuda_oom(exc: RuntimeError) -> bool:
    # TorchScript may wrap OutOfMemoryError in an ordinary RuntimeError.
    return isinstance(exc, torch.cuda.OutOfMemoryError) or "cuda out of memory" in str(exc).lower()


def transcribe(
    audio_path: Union[str, Path],
    *,
    chunk_seconds: float = 10.0,
    overlap_seconds: float = 1.0,
    progress: Callable[[float, float], None] | None = None,
) -> str:
    """Transcribe an audio file and return its text.

    Supports audio formats readable by SoundFile (for example WAV and FLAC).
    Audio is read in bounded windows and converted to mono, 16 kHz. Each window
    contains chunk_seconds of new audio plus up to overlap_seconds of context
    on either side (12 seconds total with defaults). Context predictions are
    discarded before continuous CTC decoding; no spaces are invented at joins.

    CUDA OOM halves the chunk size, down to one second, retrying the same audio.
    progress, if provided, receives (completed_seconds, total_seconds).
    The model is loaded lazily and reused; calls in one process are serialized.
    """
    if not math.isfinite(chunk_seconds) or chunk_seconds < 1:
        raise ValueError("chunk_seconds must be finite and at least 1")
    if not math.isfinite(overlap_seconds) or not 0 <= overlap_seconds < chunk_seconds / 2:
        raise ValueError("overlap_seconds must be finite, non-negative and less than half chunk_seconds")

    with _TRANSCRIBE_LOCK, sf.SoundFile(str(audio_path)) as source:
        total_frames = len(source)
        sample_rate = source.samplerate
        if total_frames == 0:
            return ""
        device = _get_device()
        model, tokens, blank = _load_model(device)
        output_tokens: list[str] = []
        previous = None
        position = 0
        current_chunk = chunk_seconds
        current_overlap = overlap_seconds

        while position < total_frames:
            end = min(total_frames, position + round(current_chunk * sample_rate))
            context = round(current_overlap * sample_rate)
            read_start = max(0, position - context)
            read_end = min(total_frames, end + context)
            source.seek(read_start)
            wav = source.read(read_end - read_start, dtype="float32", always_2d=True).mean(axis=1)
            if sample_rate != SAMPLE_RATE:
                wav = librosa.resample(wav, orig_sr=sample_rate, target_sr=SAMPLE_RATE)
            wav = np.asarray(wav, dtype=np.float32)
            # wav2vec2's convolutional frontend needs at least 400 samples.
            # Pad very short files/tails to 100 ms rather than dropping them.
            real_samples = len(wav)
            if real_samples < 1600:
                wav = np.pad(wav, (0, 1600 - real_samples))

            token_ids = None
            try:
                token_ids = _predict_ids(model, wav, device)
            except RuntimeError as exc:
                if device.type != "cuda" or not _is_cuda_oom(exc):
                    raise
                if current_chunk <= 1:
                    raise RuntimeError(
                        "CUDA is out of memory even with a 1-second chunk. "
                        "Stop other GPU/Python jobs and restart this process, "
                        "or set STT_DEVICE=cpu and retry."
                    ) from exc
            if token_ids is None:
                # Outside except: its traceback no longer holds failed tensors.
                gc.collect()
                torch.cuda.empty_cache()
                smaller_chunk = max(1.0, current_chunk / 2)
                current_overlap *= smaller_chunk / current_chunk
                current_chunk = smaller_chunk
                _LOGGER.warning("CUDA OOM at %.1fs; retrying with %.2fs chunks", position / sample_rate, current_chunk)
                continue

            # Map sample boundaries proportionally to the model's CTC frames.
            # Remove overlap BEFORE collapsing repeats, keeping CTC state across
            # chunks so duplicated boundary letters are not emitted twice.
            frames_per_sample = len(token_ids) / len(wav)
            start_sample = (position - read_start) * SAMPLE_RATE / sample_rate
            end_sample = (end - read_start) * SAMPLE_RATE / sample_rate
            first = round(start_sample * frames_per_sample)
            last = len(token_ids) if end == total_frames and real_samples == len(wav) else round(end_sample * frames_per_sample)
            # A sub-frame recording must still get one prediction after padding.
            last = min(len(token_ids), max(first + 1, last))
            for token_id in token_ids[first:last]:
                if token_id != previous and token_id != blank:
                    output_tokens.append(tokens.get(token_id, ""))
                previous = token_id
            position = end
            if progress is not None:
                progress(position / sample_rate, total_frames / sample_rate)

    text = "".join(output_tokens).replace("|", " ").replace("_", " ")
    return re.sub(r"\s+", " ", text).strip()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Transcribe Kazakh/Russian audio offline")
    parser.add_argument("audio", help="Path to an audio file, e.g. recording.wav")
    parser.add_argument("--chunk-seconds", type=float, default=10.0, help="New audio per chunk (default: 10)")
    parser.add_argument("--overlap-seconds", type=float, default=1.0, help="Context on each side (default: 1)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    print(transcribe(
        args.audio,
        chunk_seconds=args.chunk_seconds,
        overlap_seconds=args.overlap_seconds,
        progress=lambda done, total: _LOGGER.info("%.1f / %.1f s (%.0f%%)", done, total, 100 * done / total),
    ))
