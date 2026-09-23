"""Start the local Q4_K_S model and audio API together inside Linux/WSL.

Windows users run start.cmd. Model files must already be present locally.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, build_opener, urlopen


PROJECT_DIR = Path(__file__).resolve().parent
MODEL_ALIAS = "gemma-4-12b-it-Q4_K_S"
LOG_DIR = PROJECT_DIR / "results" / "launcher"
RUNTIME_DIR = PROJECT_DIR / ".runtime" / "llama"
DEFAULT_BINARY = RUNTIME_DIR / "llama-b11125" / "llama-server"
RUNTIME_ARCHIVE = RUNTIME_DIR / "llama-b11125.tar.gz"
RUNTIME_URL = "https://github.com/ggml-org/llama.cpp/releases/download/b11125/llama-b11125-bin-ubuntu-x64.tar.gz"
RUNTIME_SHA256 = "3d18a45257ca5076d460f4dc844f0d459f5c6f67cabe3c4ebdfe2ef8169b72ef"


class LaunchError(RuntimeError):
    """An actionable startup or child-process failure."""


@dataclass(frozen=True)
class Config:
    model_path: Path
    binary: Path
    llama_port: int = 8080
    api_port: int = 8000
    gpu_layers: int = 0
    startup_timeout: float = 600
    host: str = "0.0.0.0"


def resolve_path(value: str, project_dir: Path = PROJECT_DIR) -> Path:
    """Accept project-relative, Linux, or Windows drive paths inside WSL."""
    if re.match(r"^[A-Za-z]:[\\/]", value):
        value = f"/mnt/{value[0].lower()}/{value[3:].replace(chr(92), '/')}"
    path = Path(value).expanduser()
    return (path if path.is_absolute() else project_dir / path).resolve()


def _integer(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError as exc:
        raise LaunchError(f"{name} must be an integer.") from exc
    if not minimum <= value <= maximum:
        raise LaunchError(f"{name} must be between {minimum} and {maximum}.")
    return value


def load_config() -> Config:
    try:
        from dotenv import load_dotenv
    except ImportError as exc:
        raise LaunchError("python-dotenv is missing. Use the project's WSL Python environment.") from exc
    load_dotenv(PROJECT_DIR / ".env", override=False)
    binary_value = os.environ.get("LLAMA_SERVER_BINARY", str(DEFAULT_BINARY))
    # A bare executable name can be resolved through PATH; paths are project-relative.
    binary_on_path = shutil.which(binary_value) if not re.search(r"[\\/]", binary_value) else None
    try:
        timeout = float(os.environ.get("LLAMA_STARTUP_TIMEOUT", "600"))
    except ValueError as exc:
        raise LaunchError("LLAMA_STARTUP_TIMEOUT must be a positive number of seconds.") from exc
    if not math.isfinite(timeout) or timeout <= 0:
        raise LaunchError("LLAMA_STARTUP_TIMEOUT must be a positive number of seconds.")
    return Config(
        model_path=resolve_path(os.environ.get("LLAMA_MODEL_PATH", f"models/llm/{MODEL_ALIAS}.gguf")),
        binary=resolve_path(binary_on_path or binary_value),
        llama_port=_integer("LLAMA_PORT", 8080, 1, 65535),
        api_port=_integer("PORT", 8000, 1, 65535),
        gpu_layers=_integer("LLAMA_GPU_LAYERS", 0, -1, 10000),
        startup_timeout=timeout,
        host=os.environ.get("HOST", "0.0.0.0"),
    )


def build_llama_command(config: Config) -> list[str]:
    return [str(config.binary), "-m", str(config.model_path), "--alias", MODEL_ALIAS,
            "--host", "127.0.0.1", "--port", str(config.llama_port), "--jinja",
            "-c", "8192", "-np", "1", "-ngl", str(config.gpu_layers),
            "-b", "512", "-ub", "128", "--no-warmup"]


def _verify_archive(path: Path) -> None:
    digest = hashlib.sha256()
    with path.open("rb") as archive:
        for block in iter(lambda: archive.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != RUNTIME_SHA256:
        raise LaunchError(f"Runtime archive SHA256 mismatch: {path}. Remove this archive and run start.cmd again.")


def prepare_runtime(config: Config, allow_download: bool = True) -> None:
    """Install the pinned Linux CPU runtime; never fetch model weights."""
    if config.binary != DEFAULT_BINARY:
        return
    if sys.platform != "linux" or platform.machine().lower() not in {"x86_64", "amd64"}:
        raise LaunchError("The bundled llama.cpp runtime requires x86_64 Linux/WSL.")
    if config.binary.is_file():
        return
    if not allow_download:
        raise LaunchError(f"Runtime is not installed: {config.binary}. Run start.cmd once to prepare it.")
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    if not RUNTIME_ARCHIVE.is_file():
        part = RUNTIME_ARCHIVE.with_suffix(".tar.gz.part")
        print("First launch: downloading the pinned llama.cpp CPU runtime from GitHub (about 17 MB)...", flush=True)
        try:
            with urlopen(RUNTIME_URL, timeout=60) as response, part.open("wb") as destination:
                shutil.copyfileobj(response, destination)
            _verify_archive(part)
            part.replace(RUNTIME_ARCHIVE)
        except (OSError, URLError) as exc:
            raise LaunchError(f"Could not download llama.cpp: {exc}. Retry start.cmd or set LLAMA_SERVER_BINARY.") from exc
    _verify_archive(RUNTIME_ARCHIVE)
    print(f"Preparing llama.cpp runtime in {RUNTIME_DIR}...", flush=True)
    try:
        with tarfile.open(RUNTIME_ARCHIVE, "r:gz") as archive:
            archive.extractall(RUNTIME_DIR, filter="data")
    except (OSError, tarfile.TarError) as exc:
        raise LaunchError(f"Could not extract llama.cpp runtime: {exc}") from exc
    if not config.binary.is_file() or not os.access(config.binary, os.X_OK):
        raise LaunchError(f"The runtime archive did not provide an executable: {config.binary}.")


def llama_environment(config: Config) -> dict[str, str]:
    environment = child_environment(config)
    library_path = environment.get("LD_LIBRARY_PATH")
    environment["LD_LIBRARY_PATH"] = str(config.binary.parent) + (f":{library_path}" if library_path else "")
    return environment


def child_environment(config: Config) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(
        LLM_PROVIDER="local_llama", LLAMA_MODEL=MODEL_ALIAS,
        LLAMA_URL=f"http://127.0.0.1:{config.llama_port}",
        HOST=config.host, PORT=str(config.api_port), PYTHONUNBUFFERED="1",
    )
    return environment


def ensure_ports_available(config: Config) -> None:
    if config.llama_port == config.api_port:
        raise LaunchError("LLAMA_PORT and PORT must be different.")
    for name, port in (("Gemma", config.llama_port), ("API", config.api_port)):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind(("0.0.0.0", port))
        except OSError as exc:
            raise LaunchError(
                f"{name} port {port} is unavailable. Stop the existing service or change "
                "LLAMA_PORT/PORT in .env. Existing processes will not be stopped."
            ) from exc


def preflight(config: Config) -> None:
    if sys.platform != "linux":
        raise LaunchError("Run start.cmd from Windows, or this script in Linux/WSL.")
    if config.binary == DEFAULT_BINARY and config.gpu_layers != 0:
        raise LaunchError(
            "The bundled llama.cpp runtime is CPU-only. Set LLAMA_GPU_LAYERS=0, "
            "or set LLAMA_SERVER_BINARY to a Linux CUDA build for GPU inference."
        )
    if config.model_path.name != f"{MODEL_ALIAS}.gguf":
        raise LaunchError(f"LLAMA_MODEL_PATH must point to {MODEL_ALIAS}.gguf.")
    if not config.model_path.is_file() or config.model_path.stat().st_size == 0:
        raise LaunchError(f"Q4_K_S model is missing or empty: {config.model_path}. Set LLAMA_MODEL_PATH in .env.")
    if not config.binary.is_file() or not os.access(config.binary, os.X_OK):
        raise LaunchError(
            f"Linux llama-server is missing or not executable: {config.binary}. "
            "Run start.cmd to prepare the runtime, or set LLAMA_SERVER_BINARY in .env."
        )
    if config.binary.suffix.lower() == ".exe":
        raise LaunchError("LLAMA_SERVER_BINARY must be a Linux executable for this WSL launcher.")
    if not shutil.which(os.environ.get("FFMPEG_BINARY", "ffmpeg")):
        raise LaunchError("FFmpeg is missing in WSL. Install ffmpeg or set FFMPEG_BINARY in .env.")
    ensure_ports_available(config)
    # NeMo/PyTorch imports can retain over 1 GB. Release the check process before
    # loading Gemma so the supervisor does not compete with inference for RAM.
    result = subprocess.run(
        [sys.executable, "-c", "from launch_project import check_dependencies; check_dependencies()"],
        cwd=PROJECT_DIR, env=child_environment(config), capture_output=True,
        text=True, encoding="utf-8", errors="replace", timeout=180,
    )
    if result.returncode:
        detail = (result.stderr or result.stdout)[-6000:]
        raise LaunchError(f"Dependency/model check failed in {sys.executable}:\n{detail}")


def check_dependencies() -> None:
    """Run in a short-lived process to keep the supervisor's RAM usage small."""
    try:
        from local_models import MODEL_FILES, configure_offline_runtime, require_model
        configure_offline_runtime()
        for name in MODEL_FILES:
            require_model(name)
        # Importing these modules does not load model weights or start an HTTP server.
        for name in ("server", "waitress", "stt_kazakh_russian"):
            importlib.import_module(name)
        import torch
        if not torch.cuda.is_available():
            raise LaunchError("CUDA is unavailable in WSL PyTorch. The speech recognizer requires CUDA; see README.md.")
        # Diarization imports are lazy in the API; validate them before declaring readiness.
        from nemo.collections.asr.models import ClusteringDiarizer  # noqa: F401
    except LaunchError:
        raise
    except Exception as exc:
        raise LaunchError(f"Dependency/model check failed in {sys.executable}: {exc}") from exc


def _log_tail(path: Path) -> str:
    try:
        with path.open("rb") as log:
            log.seek(0, os.SEEK_END)
            log.seek(max(0, log.tell() - 8192))
            return "\n".join(log.read().decode("utf-8", errors="replace").splitlines()[-20:])
    except OSError:
        return "(log unavailable)"


def _check_children(children: list[tuple[str, subprocess.Popen, Path]]) -> None:
    for name, process, path in children:
        code = process.poll()
        if code is not None:
            raise LaunchError(f"{name} exited with code {code}. Log: {path}\n{_log_tail(path)}")


def _get(url: str) -> tuple[int, object]:
    # Loopback checks must not be sent to an HTTP proxy configured in the environment.
    opener = build_opener(ProxyHandler({}))
    try:
        with opener.open(url, timeout=2) as response:
            return response.status, json.load(response)
    except HTTPError as exc:
        return exc.code, None


def _wait_ready(config: Config, children: list[tuple[str, subprocess.Popen, Path]], *, api: bool) -> None:
    timeout = 60 if api else config.startup_timeout
    deadline = time.monotonic() + timeout
    next_notice = time.monotonic() + 15
    name = "API" if api else "Gemma"
    while time.monotonic() < deadline:
        _check_children(children)
        try:
            if api:
                host = "127.0.0.1" if config.host == "0.0.0.0" else config.host
                status, _ = _get(f"http://{host}:{config.api_port}/process-audio")
                if status == 405:
                    return
            else:
                base = f"http://127.0.0.1:{config.llama_port}"
                status, health = _get(f"{base}/health")
                if status == 200 and isinstance(health, dict) and health.get("status") == "ok":
                    status, models = _get(f"{base}/v1/models")
                    if status == 200 and isinstance(models, dict):
                        data = models.get("data", [])
                        if isinstance(data, list) and any(model.get("id") == MODEL_ALIAS for model in data if isinstance(model, dict)):
                            return
                        raise LaunchError(f"Gemma server did not expose the expected model alias {MODEL_ALIAS}.")
        except (URLError, OSError, ValueError):
            pass
        if time.monotonic() >= next_notice:
            print(f"Waiting for {name}... Log: {children[-1][2]}", flush=True)
            next_notice = time.monotonic() + 15
        time.sleep(0.5)
    path = children[-1][2]
    raise LaunchError(f"{name} did not become ready within {timeout:g} seconds. Log: {path}\n{_log_tail(path)}")


def stop_children(children: list[tuple[str, subprocess.Popen, Path]]) -> None:
    """Terminate only process groups created by this invocation, including descendants."""
    for _, process, _ in reversed(children):
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 5
    for _, process, _ in reversed(children):
        try:
            process.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            pass
    for _, process, _ in reversed(children):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            print(f"Could not reap child process {process.pid}.", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Check configuration/dependencies without starting services or changing files.")
    mode.add_argument("--setup-runtime", action="store_true", help="Prepare llama.cpp and print its version without loading any models.")
    mode.add_argument("--smoke-test", action="store_true", help="Start both services, verify readiness, then stop them.")
    args = parser.parse_args(argv)
    children: list[tuple[str, subprocess.Popen, Path]] = []
    logs = []
    termination_signals = [signal.SIGTERM]
    if hasattr(signal, "SIGHUP"):
        termination_signals.append(signal.SIGHUP)
    previous_signals = {signum: signal.getsignal(signum) for signum in termination_signals}

    def interrupted(signum, frame):
        raise KeyboardInterrupt

    for signum in termination_signals:
        signal.signal(signum, interrupted)
    try:
        config = load_config()
        if args.setup_runtime:
            prepare_runtime(config)
            result = subprocess.run([str(config.binary), "--version"], env=llama_environment(config), timeout=30)
            if result.returncode:
                raise LaunchError(f"llama-server --version exited with code {result.returncode}.")
            return 0
        if not args.check:
            prepare_runtime(config)
        print("Checking local model, dependencies, CUDA and ports...", flush=True)
        preflight(config)
        if args.check:
            print(f"Checks passed. Model: {config.model_path}\nGemma port: {config.llama_port}; API port: {config.api_port}")
            return 0
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        environment = child_environment(config)
        for name, command, filename in (
            ("Gemma", build_llama_command(config), "llama.log"),
            ("API", [sys.executable, "-u", str(PROJECT_DIR / "server.py")], "api.log"),
        ):
            path = LOG_DIR / filename
            log = path.open("w", encoding="utf-8")
            logs.append(log)
            print(f"Starting {name}. Log: {path}", flush=True)
            process = subprocess.Popen(command, cwd=PROJECT_DIR, env=llama_environment(config) if name == "Gemma" else environment,
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            children.append((name, process, path))
            _wait_ready(config, children, api=name == "API")
        if args.smoke_test:
            print("Startup check passed: Gemma and API are ready. Stopping test services.", flush=True)
            return 0
        print(f"\nReady: http://localhost:{config.api_port}/process-audio\n"
              f"Model: {MODEL_ALIAS}\nPress Ctrl+C to stop Gemma and the API.\n", flush=True)
        while True:
            _check_children(children)
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping services...", flush=True)
        return 0
    except (LaunchError, OSError, subprocess.TimeoutExpired) as exc:
        print(f"\nStartup failed: {exc}", file=sys.stderr, flush=True)
        return 1
    finally:
        # Further termination signals must not interrupt cleanup halfway through.
        for signum in termination_signals:
            signal.signal(signum, signal.SIG_IGN)
        previous_int = signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            stop_children(children)
        finally:
            for log in logs:
                log.close()
            for signum, handler in previous_signals.items():
                signal.signal(signum, handler)
            signal.signal(signal.SIGINT, previous_int)


if __name__ == "__main__":
    raise SystemExit(main())
