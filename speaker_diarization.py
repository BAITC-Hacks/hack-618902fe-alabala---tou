"""Local speaker diarization and time-based assignment of ASR words."""

from __future__ import annotations

import logging
import math
import gc
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock

from local_models import configure_offline_runtime, require_model

configure_offline_runtime()

import librosa
import numpy as np
import soundfile as sf
import torch


_LOGGER = logging.getLogger(__name__)
_DIARIZATION_LOCK = Lock()


def _speaker_options(num_speakers, min_speakers, max_speakers) -> dict:
    options = {"num_speakers": num_speakers, "min_speakers": min_speakers, "max_speakers": max_speakers}
    for name, value in options.items():
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 1):
            raise ValueError(f"{name} must be a positive integer")
    if num_speakers is not None and (min_speakers is not None or max_speakers is not None):
        raise ValueError("Use num_speakers OR min_speakers/max_speakers")
    if min_speakers is not None and max_speakers is not None and min_speakers > max_speakers:
        raise ValueError("min_speakers must not exceed max_speakers")
    if min_speakers is not None and min_speakers > 1:
        raise ValueError("NeMo clustering does not support min_speakers > 1; use num_speakers or max_speakers")
    return {name: value for name, value in options.items() if value is not None}


def _load_pipeline(config: dict):
    if sys.platform == "win32":
        raise RuntimeError(
            "NVIDIA NeMo requires Linux/WSL2 for this project. The native Windows "
            "environment is not supported. See README.md for WSL2 or Docker setup."
        )
    try:
        from nemo.collections.asr.models import ClusteringDiarizer
        from omegaconf import OmegaConf
    except ImportError as exc:
        raise RuntimeError(
            "NeMo could not be imported. In Linux/WSL2 with Python 3.12, run "
            "'python -m pip install -r requirements-nemo.txt'. "
            f"Underlying import error: {exc}"
        ) from exc
    # Paths always end in .nemo: NeMo restores them from disk, never from_pretrained.
    return ClusteringDiarizer(cfg=OmegaConf.create(config)).to(torch.device("cuda")).eval()


def _pipeline_config(manifest: Path, output_dir: Path, options: dict) -> dict:
    """Meeting VAD + multiscale TitaNet + clustering; no remote model names."""
    return {
        "name": "ClusterDiarizer", "device": "cuda", "sample_rate": 16000,
        "batch_size": 8, "num_workers": 0, "verbose": True,
        "diarizer": {
            "manifest_filepath": str(manifest), "out_dir": str(output_dir),
            "oracle_vad": False, "collar": 0.25, "ignore_overlap": True,
            "vad": {
                "model_path": str(require_model("vad")), "external_vad_manifest": None,
                "parameters": {
                    "window_length_in_sec": 0.63, "shift_length_in_sec": 0.01,
                    "smoothing": False, "overlap": 0.5, "onset": 0.9, "offset": 0.5,
                    "pad_onset": 0.0, "pad_offset": 0.0,
                    "min_duration_on": 0.0, "min_duration_off": 0.6,
                    "filter_speech_first": True,
                },
            },
            "speaker_embeddings": {
                "model_path": str(require_model("speaker")),
                "parameters": {
                    "window_length_in_sec": [3.0, 2.5, 2.0, 1.5, 1.0, 0.5],
                    "shift_length_in_sec": [1.5, 1.25, 1.0, 0.75, 0.5, 0.25],
                    "multiscale_weights": [1, 1, 1, 1, 1, 1], "save_embeddings": False,
                },
            },
            "clustering": {
                "parameters": {
                    "oracle_num_speakers": "num_speakers" in options,
                    "max_num_speakers": options.get("num_speakers", options.get("max_speakers", 8)),
                    "enhanced_count_thres": 80, "max_rp_threshold": 0.25,
                    "sparse_search_volume": 30, "maj_vote_spk_count": False,
                    "chunk_cluster_count": 50, "embeddings_per_chunk": 2000,
                },
            },
        },
    }


def _read_rttm(path: Path, duration: float) -> list[dict]:
    if not path.is_file():
        raise RuntimeError("NeMo finished without a diarization RTTM file")
    turns = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        fields = line.split()
        try:
            if len(fields) < 8 or fields[0] != "SPEAKER":
                raise ValueError("invalid SPEAKER row")
            start, length = float(fields[3]), float(fields[4])
            if not math.isfinite(start) or not math.isfinite(length) or length < 0:
                raise ValueError("invalid time range")
        except ValueError as exc:
            raise RuntimeError(f"Invalid NeMo RTTM row {number}: {exc}") from exc
        end = min(duration, start + length)
        start = max(0.0, start)
        if end > start:
            turns.append({"start": start, "end": end, "speaker": fields[7]})
    turns.sort(key=lambda item: (item["start"], item["end"]))
    labels = {}
    for item in turns:
        original = item["speaker"]
        if original not in labels:
            labels[original] = f"SPEAKER_{len(labels):02d}"
        item["speaker"] = labels[original]
    return turns


def diarize(
    audio_path: str | Path,
    *,
    num_speakers: int | None = None,
    min_speakers: int | None = None,
    max_speakers: int | None = None,
) -> list[dict]:
    """Return NeMo clustering speaker turns for the entire recording.

    Neural models run on CUDA, using local .nemo files only. Intermediate WAV,
    manifests and RTTM files live in a temporary directory removed after the call.
    Model instances are released before ASR starts on the same GPU.
    """
    options = _speaker_options(num_speakers, min_speakers, max_speakers)
    device = torch.device("cuda")
    if not torch.cuda.is_available():
        raise RuntimeError(
            "CUDA is unavailable. This application requires a CUDA-enabled PyTorch build "
            "and a working NVIDIA driver; CPU inference is disabled."
        )

    with _DIARIZATION_LOCK, TemporaryDirectory(prefix="meeting-nemo-") as temporary:
        work_dir = Path(temporary)
        manifest = work_dir / "manifest.jsonl"
        output_dir = work_dir / "output"
        config = _pipeline_config(manifest, output_dir, options)
        with sf.SoundFile(str(audio_path)) as source:
            if len(source) == 0:
                return []
            sample_rate = source.samplerate
            wav = source.read(dtype="float32", always_2d=True).mean(axis=1)
        duration = len(wav) / sample_rate
        if sample_rate != 16000:
            wav = librosa.resample(wav, orig_sr=sample_rate, target_sr=16000)
        wav = np.asarray(wav, dtype=np.float32)
        # MarbleNet uses a 0.63-second window. Clip padded turns to real duration.
        if len(wav) < 16000:
            wav = np.pad(wav, (0, 16000 - len(wav)))
        wav_path = work_dir / "recording.wav"
        sf.write(wav_path, wav, 16000, subtype="PCM_16")
        manifest.write_text(json.dumps({
            "audio_filepath": str(wav_path), "offset": 0,
            "duration": len(wav) / 16000, "label": "infer", "text": "-",
            "num_speakers": options.get("num_speakers"),
            "rttm_filepath": None, "uem_filepath": None,
        }) + "\n", encoding="utf-8")
        del wav
        _LOGGER.info("Loading local NeMo models on %s; audio duration %.1f seconds...", device, duration)
        pipeline = None
        try:
            pipeline = _load_pipeline(config)
            with torch.inference_mode():
                try:
                    pipeline.diarize()
                except ValueError as exc:
                    # Exact NeMo 2.7.2 no-speech signal; other errors propagate.
                    if str(exc) != "All files present in manifest contains silence, aborting next steps":
                        raise
                    _LOGGER.info("NeMo found no speech in the recording.")
                    return []
            turns = _read_rttm(output_dir / "pred_rttms" / "recording.rttm", duration)
            _LOGGER.info("Detected %d speakers; starting transcription.", len({turn["speaker"] for turn in turns}))
            return turns
        finally:
            try:
                if pipeline is not None:
                    pipeline.to(torch.device("cpu"))
            finally:
                pipeline = None
                gc.collect()
                torch.cuda.empty_cache()


def assign_speakers(
    words: list[dict], turns: list[dict], *, max_pause_seconds: float = 1.5,
) -> tuple[list[dict], list[dict]]:
    """Assign words by maximum temporal overlap and group into utterances.

    Words outside speech turns or tied between speakers get speaker=None.
    A change of turn or a long pause starts a new utterance. Input words are
    preserved and never reordered or silently discarded.
    """
    if not math.isfinite(max_pause_seconds) or max_pause_seconds < 0:
        raise ValueError("max_pause_seconds must be finite and non-negative")
    ordered_turns = sorted(turns, key=lambda turn: (turn["start"], turn["end"]))
    labelled = []
    segments = []
    cursor = 0
    previous_turn = None
    for word in words:
        start, end = word["start"], word["end"]
        while cursor < len(ordered_turns) and ordered_turns[cursor]["end"] <= start:
            cursor += 1
        overlaps: dict[str, float] = {}
        best_turns: dict[str, tuple[float, int]] = {}
        index = cursor
        while index < len(ordered_turns) and ordered_turns[index]["start"] < end:
            turn = ordered_turns[index]
            overlap = max(0.0, min(end, turn["end"]) - max(start, turn["start"]))
            if overlap > 0:
                speaker = turn["speaker"]
                overlaps[speaker] = overlaps.get(speaker, 0.0) + overlap
                if speaker not in best_turns or overlap > best_turns[speaker][0]:
                    best_turns[speaker] = (overlap, index)
            index += 1
        speaker = None
        turn_index = None
        if overlaps:
            best = max(overlaps.values())
            winners = [speaker for speaker, amount in overlaps.items() if math.isclose(amount, best, abs_tol=1e-6)]
            if len(winners) == 1:
                speaker = winners[0]
                turn_index = best_turns[speaker][1]
        labelled_word = {**word, "speaker": speaker}
        labelled.append(labelled_word)
        if (not segments or speaker != segments[-1]["speaker"] or turn_index != previous_turn
                or start - segments[-1]["end"] > max_pause_seconds):
            segments.append({"start": start, "end": end, "speaker": speaker, "text": word["word"]})
        else:
            segments[-1]["end"] = max(segments[-1]["end"], end)
            segments[-1]["text"] += " " + word["word"]
        previous_turn = turn_index
    return labelled, segments
