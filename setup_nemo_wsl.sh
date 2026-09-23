#!/usr/bin/env bash
# Run in Ubuntu 24.04/WSL2 as root. Does not read recordings or .env.
set -euo pipefail
trap 'echo "Environment setup failed at line $LINENO. Fix the error above and rerun install.cmd." >&2' ERR

if [[ "$EUID" -ne 0 ]]; then
    echo "Run this setup script as root (or with sudo)." >&2
    exit 1
fi

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python_path="${1:-/opt/qorit-nemo/bin/python}"
if [[ "$python_path" != /*/bin/python ]]; then
    echo "QORIT_PYTHON must be an absolute Linux venv path ending in /bin/python." >&2
    exit 1
fi
venv_dir="${python_path%/bin/python}"
if [[ -d "$venv_dir" && ! -f "$venv_dir/pyvenv.cfg" ]] &&
   [[ -n "$(find "$venv_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "Refusing to turn an existing non-venv directory into a venv: $venv_dir" >&2
    exit 1
fi

. /etc/os-release
if [[ "$ID" != ubuntu || "$VERSION_ID" != 24.04 || "$(uname -m)" != x86_64 ]]; then
    echo "This setup requires Ubuntu 24.04 x86_64 (Python 3.12 and CUDA wheels)." >&2
    exit 1
fi
kernel="$(uname -r)"
if [[ "${kernel,,}" == *microsoft* && "${kernel,,}" != *wsl2* ]]; then
    echo "WSL2 is required. Run wsl --set-version <distribution-name> 2 in Windows." >&2
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3.12-venv build-essential ca-certificates ffmpeg libsndfile1 libgomp1 sox fonts-dejavu-core
python3.12 -m venv "$venv_dir"
"$venv_dir/bin/python" -m pip install --upgrade pip setuptools wheel
"$venv_dir/bin/python" -m pip install -r "$project_dir/requirements-nemo.txt"
"$venv_dir/bin/python" -m pip check
printf '\nNeMo environment prepared: %s\n' "$venv_dir"
