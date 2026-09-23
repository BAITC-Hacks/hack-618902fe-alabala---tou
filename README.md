# hack-618902fe-alabala---tou
Hackathon team repository for Alabala - ToU

## Speech recognition on RTX 5050 (Windows PowerShell)

The existing `.venv` may be unusable if its Python installation was removed. It
also contains a CPU-only PyTorch build (`torch.version.cuda` is `None`). Create a
fresh environment with an installed Python 3.10–3.14 (3.12 recommended):

```powershell
py -3.12 -m venv .venv-gpu
.\.venv-gpu\Scripts\python.exe -m pip install --upgrade pip
.\.venv-gpu\Scripts\python.exe -m pip install torch==2.14.0 --index-url https://download.pytorch.org/whl/cu130
.\.venv-gpu\Scripts\python.exe -m pip install huggingface_hub soundfile librosa
```

If `py -3.12` is unavailable, install Python 3.12 or replace it with the path
to an installed Python executable. Select `.venv-gpu\Scripts\python.exe` as
the interpreter in VS Code.

Verify that PyTorch sees the GPU before loading the model:

```powershell
.\.venv-gpu\Scripts\python.exe -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CUDA unavailable')"
```

The version should contain `+cu130`, and `torch.cuda.is_available()` should
print `True`. `nvidia-smi` reporting a CUDA version only confirms driver
support; it does not mean the installed PyTorch has CUDA enabled.

Run transcription with the GPU:

```powershell
.\.venv-gpu\Scripts\python.exe .\test.py
# Or transcribe one recording:
.\.venv-gpu\Scripts\python.exe .\stt_kazakh_russian.py ".\media\Совещание №1.mp3"
```

The model downloads from Hugging Face on first use. GPU execution is the
default. For a CPU run, set `$env:STT_DEVICE = 'cpu'` before running the
script. Clear it with `Remove-Item Env:STT_DEVICE` to use the GPU again.
