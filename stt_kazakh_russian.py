"""Offline Kazakh/Russian speech-to-text helper.

Models must already exist in the local models directory. Inference never
downloads weights. See prepare_models.py for the separate provisioning step.

See README.md for the GPU installation instructions.

Example:
    from stt_kazakh_russian import transcribe

    text = transcribe("meeting.wav")
    print(text)
"""

from __future__ import annotations

import re
import gc
import logging
import math
from functools import lru_cache
from pathlib import Path
from threading import RLock
from typing import Callable, Union

from local_models import configure_offline_runtime, require_model

configure_offline_runtime()

import librosa
import numpy as np
import soundfile as sf
import torch


SAMPLE_RATE = 16000
_LOGGER = logging.getLogger(__name__)
_TRANSCRIBE_LOCK = RLock()  # Also covers the complete diarization + ASR operation.


class _WordDecoder:
    """Continuous greedy CTC decoding with approximate word timestamps."""

    def __init__(self, tokens: dict[int, str], blank: int):
        self.tokens = tokens
        self.blank = blank
        self.previous = None
        self.words: list[dict] = []
        self.parts: list[str] = []
        self.start = 0.0
        self.end = 0.0

    def finish_word(self) -> None:
        if self.parts:
            self.words.append({"word": "".join(self.parts), "start": self.start, "end": self.end})
            self.parts = []

    def push(self, token_id: int, start: float, end: float) -> None:
        symbol = self.tokens.get(token_id, "").replace("|", " ").replace("_", " ")
        if token_id != self.blank:
            if token_id != self.previous:
                for part in re.findall(r"\s+|\S+", symbol):
                    if part.isspace():
                        self.finish_word()
                    else:
                        if not self.parts:
                            self.start = start
                        self.parts.append(part)
                        self.end = end
            elif self.parts and symbol and not symbol[-1].isspace():
                self.end = max(self.end, end)
        self.previous = token_id

    def result(self, duration: float) -> dict:
        self.finish_word()
        return {
            "text": " ".join(word["word"] for word in self.words),
            "duration": duration,
            "words": self.words,
            "timestamps_approximate": True,
        }


def _get_device() -> torch.device:
    if not torch.cuda.is_available():
        raise RuntimeError(
            f"CUDA is unavailable in PyTorch {torch.__version__} "
            f"(built with CUDA: {torch.version.cuda}). "
            "Install a CUDA-enabled PyTorch build and check that the NVIDIA driver "
            "is working. This application requires CUDA; CPU inference is disabled. See README.md."
        )
    return torch.device("cuda")


@lru_cache(maxsize=1)
def _load_model(device: torch.device):
    model_path = require_model("asr")
    tokens_path = require_model("tokens")

    model = torch.jit.load(model_path, map_location=device).eval()
    tokens: dict[int, str] = {}
    with open(tokens_path, encoding="utf-8") as token_file:
        for line in token_file:
            if line.strip():
                symbol, index = line.rstrip("\n").split("\t")
                tokens[int(index)] = symbol

    return model, tokens, max(tokens) + 1  # CTC blank token is the final index


def release_models() -> None:
    """Release cached ASR weights before another local model uses the GPU."""
    with _TRANSCRIBE_LOCK:
        _load_model.cache_clear()
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


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


def _validate_windows(chunk_seconds: float, overlap_seconds: float) -> None:
    if not math.isfinite(chunk_seconds) or chunk_seconds < 1:
        raise ValueError("chunk_seconds must be finite and at least 1")
    if not math.isfinite(overlap_seconds) or not 0 <= overlap_seconds < chunk_seconds / 2:
        raise ValueError("overlap_seconds must be finite, non-negative and less than half chunk_seconds")


def transcribe(
    audio_path: Union[str, Path],
    *,
    chunk_seconds: float = 10.0,
    overlap_seconds: float = 1.0,
    progress: Callable[[float, float], None] | None = None,
) -> str:
    """Transcribe an audio file and return its text (backwards compatible API)."""
    return transcribe_with_timestamps(
        audio_path,
        chunk_seconds=chunk_seconds,
        overlap_seconds=overlap_seconds,
        progress=progress,
    )["text"]


def transcribe_with_timestamps(
    audio_path: Union[str, Path],
    *,
    chunk_seconds: float = 10.0,
    overlap_seconds: float = 1.0,
    progress: Callable[[float, float], None] | None = None,
) -> dict:
    """Return text, duration and words with approximate start/end times in seconds.

    Supports audio formats readable by SoundFile (for example WAV and FLAC).
    Audio is read in bounded windows and converted to mono, 16 kHz. Each window
    contains chunk_seconds of new audio plus up to overlap_seconds of context
    on either side (12 seconds total with defaults). Context predictions are
    discarded before continuous CTC decoding; no spaces are invented at joins.

    CUDA OOM halves the chunk size, down to one second, retrying the same audio.
    progress, if provided, receives (completed_seconds, total_seconds).
    The model is loaded lazily and reused; calls in one process are serialized.
    Timing uses proportional CTC frame positions, not forced alignment.
    """
    _validate_windows(chunk_seconds, overlap_seconds)

    with _TRANSCRIBE_LOCK, sf.SoundFile(str(audio_path)) as source:
        total_frames = len(source)
        sample_rate = source.samplerate
        if total_frames == 0:
            return _WordDecoder({}, 0).result(0.0)
        device = _get_device()
        model, tokens, blank = _load_model(device)
        decoder = _WordDecoder(tokens, blank)
        duration = total_frames / sample_rate
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
                        "free GPU memory, and retry. CPU inference is disabled."
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
            for frame in range(first, last):
                start_time = max(position / sample_rate, read_start / sample_rate + frame / frames_per_sample / SAMPLE_RATE)
                end_time = min(end / sample_rate, read_start / sample_rate + (frame + 1) / frames_per_sample / SAMPLE_RATE)
                start_time = min(start_time, end_time)
                decoder.push(token_ids[frame], start_time, end_time)
            position = end
            if progress is not None:
                progress(position / sample_rate, total_frames / sample_rate)

    return decoder.result(duration)


def transcribe_diarized(
    audio_path: Union[str, Path],
    *,
    chunk_seconds: float = 10.0,
    overlap_seconds: float = 1.0,
    progress: Callable[[float, float], None] | None = None,
    num_speakers: int | None = None,
    min_speakers: int | None = None,
    max_speakers: int | None = None,
) -> dict:
    """Return transcript, timed words, speaker turns and grouped utterances.

    Speaker IDs are local to the recording and do not identify real people.
    Requires local NeMo model files and a Linux/WSL2 environment; see README.
    """
    from speaker_diarization import assign_speakers, diarize

    _validate_windows(chunk_seconds, overlap_seconds)
    with _TRANSCRIBE_LOCK:
        # Release the previous file's ASR weights before loading NeMo on the GPU.
        _load_model.cache_clear()
        gc.collect()
        torch.cuda.empty_cache()
        turns = diarize(
            audio_path,
            num_speakers=num_speakers,
            min_speakers=min_speakers,
            max_speakers=max_speakers,
        )
        result = transcribe_with_timestamps(
            audio_path,
            chunk_seconds=chunk_seconds,
            overlap_seconds=overlap_seconds,
            progress=progress,
        )
        words, segments = assign_speakers(result["words"], turns)
        return {
            **result,
            "words": words,
            "segments": segments,
            "speakers": sorted({turn["speaker"] for turn in turns}),
            "speaker_turns": turns,
        }


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Transcribe Kazakh/Russian audio offline")
    parser.add_argument("audio", help="Path to an audio file, e.g. recording.wav")
    parser.add_argument("--chunk-seconds", type=float, default=10.0, help="New audio per chunk (default: 10)")
    parser.add_argument("--overlap-seconds", type=float, default=1.0, help="Context on each side (default: 1)")
    parser.add_argument("--diarize", action="store_true", help="Return JSON with speaker-labelled utterances")
    parser.add_argument("--num-speakers", type=int, help="Known number of speakers (requires --diarize)")
    args = parser.parse_args()
    if args.num_speakers is not None and not args.diarize:
        parser.error("--num-speakers requires --diarize")
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    transcriber = transcribe_diarized if args.diarize else transcribe
    result = transcriber(
        args.audio,
        chunk_seconds=args.chunk_seconds,
        overlap_seconds=args.overlap_seconds,
        progress=lambda done, total: _LOGGER.info("%.1f / %.1f s (%.0f%%)", done, total, 100 * done / total),
        **({"num_speakers": args.num_speakers} if args.diarize else {}),
    )
    print(json.dumps(result, ensure_ascii=False, indent=2) if args.diarize else result)
