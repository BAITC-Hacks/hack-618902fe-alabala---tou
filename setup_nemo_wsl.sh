#!/usr/bin/env bash
# Run once in Ubuntu 24.04/WSL2 as root. Does not read recordings or .env.
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
    echo "Run this setup script as root (or with sudo)." >&2
    exit 1
fi

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
venv_dir=/opt/qorit-nemo

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3.12-venv build-essential ffmpeg libsndfile1 sox fonts-dejavu-core
python3.12 -m venv "$venv_dir"
"$venv_dir/bin/python" -m pip install --upgrade pip setuptools wheel
"$venv_dir/bin/python" -m pip install -r "$project_dir/requirements-nemo.txt"
printf '\nNeMo environment prepared: %s\n' "$venv_dir"
