"""Provision public model files; never reads recordings, transcripts or .env.

Network access is opt-in (--download). The runtime does not import this script.
This helper needs only the Python standard library, including on Windows.
"""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
from urllib.request import urlopen
import zipfile

from local_models import MODEL_FILES, models_directory


ASR_REVISION = "26298d2a61dc1573bfc11b7055c7d09a1e64b8a4"
ASR_BASE = f"https://huggingface.co/alibiserikbay/kazakh-russian-mixed-stt/resolve/{ASR_REVISION}/asr/rukk"
MODEL_URLS = {
    "asr": f"{ASR_BASE}/model.pt",
    "tokens": f"{ASR_BASE}/tokens.lst",
    "vad": "https://api.ngc.nvidia.com/v2/models/nvidia/nemo/vad_multilingual_marblenet/versions/1.10.0/files/vad_multilingual_marblenet.nemo",
    "speaker": "https://api.ngc.nvidia.com/v2/models/nvidia/nemo/titanet_large/versions/v1/files/titanet-l.nemo",
}


def validate_file(name: str, path: Path) -> None:
    """Reject missing, truncated, HTML and Git LFS placeholder files."""
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError("file is missing or empty")
    if name == "tokens":
        rows = path.read_text(encoding="utf-8").splitlines()
        if not rows or any(len(row.split("\t")) != 2 for row in rows if row.strip()):
            raise ValueError("expected a token/index TSV file")
        for row in rows:
            if row.strip():
                int(row.split("\t")[1])
    elif name == "asr":
        with zipfile.ZipFile(path) as archive:
            if not any(item.endswith("/data.pkl") for item in archive.namelist()):
                raise ValueError("expected a TorchScript archive")
    else:
        with tarfile.open(path, "r:*") as archive:
            names = {Path(item.name).name for item in archive.getmembers()}
            if not {"model_config.yaml", "model_weights.ckpt"}.issubset(names):
                raise ValueError("expected a NeMo model archive")


def cached_asr(name: str, cache_dir: Path) -> Path | None:
    filename = MODEL_FILES[name].name
    path = (cache_dir / "models--alibiserikbay--kazakh-russian-mixed-stt"
            / "snapshots" / ASR_REVISION / "asr" / "rukk" / filename)
    return path if path.is_file() else None


def provision(name: str, target: Path, cached: Path | None) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    # A failed/interrupted transfer never replaces a working model.
    with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".part", delete=False) as output:
        temporary = Path(output.name)
    try:
        if cached is not None:
            print(f"Copying cached {name}: {cached}", flush=True)
            shutil.copyfile(cached, temporary)
        else:
            print(f"Downloading {name} from a public model URL...", flush=True)
            # No login, auth headers or files from the project are sent.
            with urlopen(MODEL_URLS[name], timeout=120) as response, temporary.open("wb") as output:
                expected = response.headers.get("Content-Length")
                transferred = 0
                next_report = 50 * 1024 * 1024
                while block := response.read(1024 * 1024):
                    output.write(block)
                    transferred += len(block)
                    if transferred >= next_report:
                        print(f"  {transferred / 1024 / 1024:.0f} MiB", flush=True)
                        next_report += 50 * 1024 * 1024
                if expected is not None and transferred != int(expected):
                    raise ValueError(f"incomplete download: {transferred}/{expected} bytes")
        validate_file(name, temporary)
        with temporary.open("rb") as source:
            checksum = hashlib.file_digest(source, "sha256").hexdigest()
        temporary.replace(target)
        print(f"Ready: {target}\n  SHA256: {checksum}", flush=True)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare local ASR and NeMo weights without registration")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--download", action="store_true", help="Explicitly allow downloading missing model files")
    actions.add_argument("--check", action="store_true", help="Check local files only (default; no network)")
    parser.add_argument("--models-dir", type=Path, help="Destination; default LOCAL_MODELS_DIR or ./models")
    parser.add_argument("--hf-cache", type=Path, help="Reuse this local Hugging Face hub cache for ASR when downloading")
    args = parser.parse_args()
    directory = models_directory(args.models_dir)
    cache = args.hf_cache
    if cache is None:
        cache = Path(os.environ.get("HF_HUB_CACHE") or
                     str(Path(os.environ.get("HF_HOME", "~/.cache/huggingface")).expanduser() / "hub"))
    failed = False
    for name, relative in MODEL_FILES.items():
        target = directory / relative
        try:
            validate_file(name, target)
            print(f"OK: {target}", flush=True)
            continue
        except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile) as exc:
            print(f"Missing/invalid {name}: {exc}", flush=True)
        if not args.download:
            failed = True
            continue
        try:
            cached = cached_asr(name, cache.expanduser()) if name in {"asr", "tokens"} else None
            provision(name, target, cached)
        except Exception as exc:
            print(f"Failed to prepare {name}: {exc}", file=sys.stderr)
            failed = True
    if failed:
        print("Models are not ready. Use --download during setup or copy prepared files into models/.", file=sys.stderr)
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
