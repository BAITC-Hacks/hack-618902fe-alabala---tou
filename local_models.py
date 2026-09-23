"""Shared local model layout. Importing this module never downloads anything."""

from __future__ import annotations

import os
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parent
MODEL_FILES = {
    "asr": Path("asr/rukk/model.pt"),
    "tokens": Path("asr/rukk/tokens.lst"),
    "vad": Path("diarization/marblenet.nemo"),
    "speaker": Path("diarization/titanet_large.nemo"),
}


def models_directory(directory: str | Path | None = None) -> Path:
    """Resolve relative paths against the project, independently of the cwd."""
    path = Path(directory or os.environ.get("LOCAL_MODELS_DIR") or "models").expanduser()
    return (path if path.is_absolute() else PROJECT_DIR / path).resolve()


def require_model(name: str) -> Path:
    path = models_directory() / MODEL_FILES[name]
    if not path.is_file() or path.stat().st_size == 0:
        raise FileNotFoundError(
            f"Local model is missing: {path}. Automatic downloads are disabled. "
            "Run 'python prepare_models.py --download' during setup, or copy the "
            "prepared models directory from another computer. No account/token is required."
        )
    return path


def configure_offline_runtime() -> None:
    """Disable Hub downloads and common telemetry before importing ML libraries.

    These flags are library settings, not an OS firewall. Docker's --network none
    provides network isolation for the entire inference process (see README).
    """
    for key, value in {
        "HF_HUB_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "DO_NOT_TRACK": "1",
        "WANDB_MODE": "disabled",
        "WANDB_DISABLED": "true",
    }.items():
        os.environ[key] = value
