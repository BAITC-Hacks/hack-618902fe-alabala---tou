"""Finish install.cmd setup inside WSL without starting the application servers."""

from __future__ import annotations

from pathlib import Path
import subprocess
import sys


PROJECT_DIR = Path(__file__).resolve().parent
CUDA_CHECK = """
import torch
if not torch.cuda.is_available():
    raise RuntimeError(
        'CUDA is unavailable. Install/update the NVIDIA driver in Windows, '
        'use WSL2, then rerun install.cmd. CPU speech recognition is not supported.'
    )
# Exercise the device as well as detecting it (e.g. unsupported GPU/driver).
torch.ones(1, device='cuda').add_(1)
torch.cuda.synchronize()
print('CUDA ready: ' + torch.cuda.get_device_name(0), flush=True)
"""


def prepare_config(project_dir: Path) -> None:
    """Create the initial configuration without replacing user settings."""
    target = project_dir / ".env"
    if target.exists():
        print("Keeping existing .env settings.", flush=True)
        return
    contents = (project_dir / ".env.example").read_text(encoding="utf-8")
    try:
        with target.open("x", encoding="utf-8") as output:
            output.write(contents)
    except FileExistsError:
        return
    print("Created .env from .env.example.", flush=True)


def run_python(*arguments: str) -> None:
    subprocess.run([sys.executable, "-u", *arguments], cwd=PROJECT_DIR, check=True)


def main() -> int:
    if sys.platform != "linux":
        print("Run install.cmd from Windows, or this helper inside Linux/WSL.", file=sys.stderr)
        return 1
    try:
        from dotenv import load_dotenv
        from launch_project import load_config

        prepare_config(PROJECT_DIR)
        # prepare_models.py deliberately does not read .env. Pass the same settings
        # to its child process that start.cmd will use, including LOCAL_MODELS_DIR.
        load_dotenv(PROJECT_DIR / ".env", override=False)
        print("Checking the NVIDIA driver and CUDA...", flush=True)
        run_python("-c", CUDA_CHECK)
        print("Preparing local speech models (existing valid files are reused)...", flush=True)
        run_python("prepare_models.py", "--download")
        print("Preparing the pinned llama.cpp runtime...", flush=True)
        run_python("launch_project.py", "--setup-runtime")
        config = load_config()
        if not config.model_path.is_file() or config.model_path.stat().st_size == 0:
            print(
                f"\nDependencies are installed, but the Gemma GGUF model is missing or empty:\n"
                f"  {config.model_path}\n"
                "Copy gemma-4-12b-it-Q4_K_S.gguf there, or set LLAMA_MODEL_PATH in .env.\n"
                "Gemma weights are not downloaded by this installer.\n"
                "Then rerun install.cmd or run start.cmd --check.",
                file=sys.stderr,
            )
            return 1
        print("Checking all startup requirements without starting servers...", flush=True)
        run_python("launch_project.py", "--check")
    except subprocess.CalledProcessError as exc:
        print(f"\nSetup step failed (exit code {exc.returncode}). See the error above.", file=sys.stderr)
        return 1
    except (ImportError, OSError, RuntimeError) as exc:
        print(f"\nSetup failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
