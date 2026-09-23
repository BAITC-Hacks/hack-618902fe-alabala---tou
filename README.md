<<<<<<< HEAD
# hack-618902fe-alabala---tou
Hackathon team repository for Alabala - ToU

## Speech recognition on RTX 5050 (Windows PowerShell)

The existing `.venv` may be unusable if its Python installation was removed. It
also contains a CPU-only PyTorch build (`torch.version.cuda` is `None`). Create a
fresh environment with an installed Python 3.10–3.14 (3.12 recommended):

```powershell
py -3.12 -m venv .venv-gpu
.\.venv-gpu\Scripts\python.exe -m pip install --upgrade pip
.\.venv-gpu\Scripts\python.exe -m pip install -r requirements.txt
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

## Long recordings and 8 GB VRAM

`transcribe(path)` now reads and processes the recording in sequence, using
10 seconds of new audio plus up to 1 second of context on each side. The full
waveform is never loaded into RAM or VRAM. Only the resulting text grows with
recording length. The model remains FP32, with one window per inference call.

Overlapping predictions are trimmed before CTC decoding, which keeps its state
across windows. This reduces boundary artifacts without blindly concatenating
duplicate words. Chunked recognition can still differ from full-file recognition;
listen to/check words around joins when accuracy matters.

Both `test.py` and the single-file CLI display progress. For smaller windows:

```powershell
python .\stt_kazakh_russian.py ".\media\Совещание №1.mp3" --chunk-seconds 5 --overlap-seconds 0.5
```

Or from Python:

```python
text = transcribe("meeting.wav", chunk_seconds=5, overlap_seconds=0.5)
```

Chunk size must be at least 1 second; overlap must be non-negative and smaller
than half the chunk size. CUDA OOM during inference automatically halves both
the chunk and its context, down to 1 second of new audio, and retries from the
same position. Other errors are not hidden. If even that fails, stop other GPU
jobs and restart the script, or run with `$env:STT_DEVICE = 'cpu'`. OOM during
model loading still requires freeing VRAM; shortening audio cannot fix that.

Run one transcription process at a time on this GPU. Calls within one process
are serialized and share a lazily loaded model; separate Python processes each
allocate their own model and working memory. After an earlier OOM, terminate
the old run before starting another. `torch.cuda.empty_cache()` only releases
unused cached allocations in the current process, not live tensors or memory
owned by other processes. Allocator tuning does not make an oversized forward
pass fit into 8 GB.

Only formats supported by the installed SoundFile/libsndfile can be read
(including MP3 in recent builds). Convert unsupported formats such as M4A to
WAV/FLAC first.

References: [model card and recommended chunk lengths](https://huggingface.co/alibiserikbay/kazakh-russian-mixed-stt),
[CTC chunking with overlap](https://huggingface.co/blog/asr-chunking),
[PyTorch CUDA memory management](https://docs.pytorch.org/docs/stable/notes/cuda.html#memory-management).
=======
# QORIT — AI-протоколирование совещаний

Рабочий прототип: транскрипт с диаризацией, поручения с ответственными и сроками, саммари и экспорт протокола. Интерфейс демонстрирует русскую, казахскую и смешанную речь.

## Запуск

Нужен только Python 3.10+.

```bash
cp .env.example .env
# В .env замените APP_IP на LAN-IP машины, если демонстрируете с другого устройства
python3 server.py
```

Откройте `http://localhost:8000` или `http://APP_IP:PORT`. Фронтенд — чистый HTML/CSS/JS, без Django и фреймворков.

## Демонстрация

1. Протокол показывает реплики с метками говорящих и `RU · KZ · MIX`.
2. «Обработать» обращается к локальному API и обновляет саммари/поручения.
3. В «Поручениях» видны суть, ответственный, срок и статус.
4. Нажмите DOCX или PDF, чтобы получить файл протокола.

Загрузка аудио/видео служит точкой подключения реального конвейера. В демо файл не отправляется наружу и не сохраняется.

## Контур и развитие

`Teams/Zoom/Meet или запись → локальный Whisper/Vosk → локальный pyannote → локальная LLM → QORIT → PDF/DOCX/СЭД`.

В `server.py` реализован автономный демонстрационный адаптер без зависимостей. В production его заменяют self-hosted STT, диаризация и LLM — параметры уже вынесены в `.env`. Аудио и текст не уходят во внешние API.
>>>>>>> my-feature
