<<<<<<< HEAD
# hack-618902fe-alabala---tou
Hackathon team repository for Alabala - ToU

## Speech recognition on RTX 5050 (Windows PowerShell)

The project uses the matching `torch==2.11.0+cu130` and
`torchaudio==2.11.0+cu130` wheels, as listed in the
[official PyTorch installation instructions](https://pytorch.org/get-started/previous-versions/#v2110).
TorchAudio 2.14.0 is unavailable. If PyTorch 2.14.0 is already installed,
`python -m pip install --upgrade -r requirements.txt` replaces it with 2.11.0
and installs the matching TorchAudio release, keeping CUDA 13.0 support.

The existing `.venv` may be unusable if its Python installation was removed. It
also contains a CPU-only PyTorch build (`torch.version.cuda` is `None`). Create a
fresh environment with an installed Python 3.10–3.14 (3.12 recommended):

```powershell
# Из корня проекта; используется уже существующий Python.
.\.venv\Scripts\python.exe prepare_models.py --download
```

Скрипт использует публичные ссылки NVIDIA NGC и Hugging Face. Уже имеющиеся файлы
не скачиваются повторно; STT берётся из локального HF-кэша, если там есть нужная
версия. При необходимости укажите `--hf-cache ПУТЬ_К_КЭШУ_HUB`.
Скачивание идёт во временный файл, затем проверяется формат архива. Для переноса
можно сравнить печатаемые SHA256. Эти суммы не являются подписью издателя.

```text
models/
  asr/rukk/model.pt
  asr/rukk/tokens.lst
  diarization/marblenet.nemo
  diarization/titanet_large.nemo
```

Для полностью отключённого компьютера скопируйте эту папку и заранее подготовленную
среду или Docker-образ. Пакеты Python также нужно установить заранее.
Команда ниже только проверяет файлы на диске, без сетевых запросов:

```bash
python prepare_models.py --check
```

Другой каталог задаётся переменной окружения `LOCAL_MODELS_DIR` и аргументом
`--models-dir` у скрипта подготовки. Относительные пути считаются от корня проекта.
CLI не читает `.env`; переменные для CLI нужно экспортировать в оболочке.

## Windows: запуск NeMo через WSL2

**NeMo не поддерживает нативный Windows Python.** Используйте Linux/WSL2 на этом
же компьютере с доступом к NVIDIA GPU. Windows `.venv` нельзя использовать как
Linux-окружение. Распознавание без диаризации может по-прежнему работать в Windows.

В этом рабочем окружении уже установлена Ubuntu 24.04. Для автоматической подготовки
отдельного окружения `/opt/qorit-nemo` используется команда из PowerShell:

```powershell
.\.venv-gpu\Scripts\python.exe -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CUDA unavailable')"
```

The version should contain `+cu130`, and `torch.cuda.is_available()` must
print `True`. The application requires CUDA for both speech recognition and
diarization. `nvidia-smi` reporting a CUDA version only confirms driver
support; it does not mean the installed PyTorch has CUDA enabled.

Run transcription with the GPU:

```powershell
.\.venv-gpu\Scripts\python.exe .\test.py
# Or transcribe one recording:
.\.venv-gpu\Scripts\python.exe .\stt_kazakh_russian.py ".\media\Совещание №1.mp3"
```

The ASR and diarization models download from Hugging Face on first use. Both
models always run on CUDA; there is no CPU execution fallback.

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
wsl --install -d Ubuntu-24.04
```

Завершите первоначальную настройку Ubuntu; если Windows попросит — перезагрузитесь.
Затем в терминале **Ubuntu/WSL**, с Python 3.12:

```python
text = transcribe("meeting.wav", chunk_seconds=5, overlap_seconds=0.5)
```

Chunk size must be at least 1 second; overlap must be non-negative and smaller
than half the chunk size. CUDA OOM during inference automatically halves both
the chunk and its context, down to 1 second of new audio, and retries from the
same position. Other errors are not hidden. If even that fails, stop other GPU
jobs, free GPU memory, and retry. CPU inference is disabled. OOM during
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

## Разбивка по говорящим (диаризация)

`transcribe_diarized(path)` сохраняет распознавание смешанной русско-казахской
речи через текущую модель `rukk` и добавляет диаризацию через
[pyannote Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1).
Сначала определяются интервалы голосов во всей записи, затем слова STT
сопоставляются с ними по времени. Смена говорящего или пауза больше 1,5 секунды
начинает новую реплику. Это разбивка по голосам и паузам; пунктуация не добавляется.

Для первого запуска:

1. Установите обновлённые зависимости в рабочее окружение Python:
   `python -m pip install -r requirements.txt`.
2. Войдите в Hugging Face и примите условия на странице модели Community-1.
3. Настройте read-токен с доступом к этой модели через `hf auth login`
   или переменную окружения `HF_TOKEN`. Токен не нужно добавлять в исходники.

```powershell
# После активации рабочего окружения Python:
hf auth login
python .\test.py --diarize
# Если количество участников известно:
python .\test.py --diarize --num-speakers 5
```

`test.py --diarize` выводит реплики с таймкодами и сохраняет результаты в
`results/<имя аудиофайла>.json`. Папку можно задать через `--output-dir`.
Пример формата вывода (иллюстрация, не результат обработки):

```text
[00:01.200–00:04.500] SPEAKER_00: коллеги начинаем совещание
[00:05.100–00:08.800] SPEAKER_01: по нашему направлению план выполнен
```

Для одного файла с выводом JSON:

```powershell
python .\stt_kazakh_russian.py ".\media\Совещание №1.mp3" --diarize
```

Из Python, например для дальнейшего подключения к серверу:

```python
from stt_kazakh_russian import transcribe_diarized

result = transcribe_diarized("meeting.wav", min_speakers=2, max_speakers=8)
for segment in result["segments"]:
    print(segment["start"], segment["end"], segment["speaker"], segment["text"])
```

Результат содержит `text`, `duration`, `words`, `segments`, `speakers` и
`speaker_turns`. Время указано в секундах от начала записи. В `words` у каждого
слова есть `word`, `start`, `end`, `speaker`; в `segments` — `text`, `start`,
`end`, `speaker`. `speaker_turns` содержит интервалы, полученные от pyannote.
Можно задать точное `num_speakers` либо границы `min_speakers`/`max_speakers`.

Таймкоды слов приблизительные (`timestamps_approximate: true`): они рассчитаны
по выходным CTC-кадрам текущей модели. Слово получает голос с наибольшим
пересечением по времени. Если пересечения нет или два голоса набрали одинаковое
пересечение, `speaker` равен `null` (в консоли `UNKNOWN`). Слова сохраняются
даже без определённого говорящего.

`SPEAKER_00` — условный голос в пределах одной записи. Имена участников и
исполнители поручений автоматически не определяются. Используется exclusive
диаризация: на интервал назначается один голос. Одновременная речь нескольких
людей не разделяется на независимые аудиодорожки и может распознаваться неверно.
Качество разделения голосов при переключении между языками нужно оценить на
реальных записях совещаний.

Диаризация и STT всегда выполняются на CUDA GPU. Модель диаризации после обработки
освобождает VRAM перед запуском STT. Диаризация хранит полную волну записи в RAM для

согласованного определения голосов. Загрузка
модели при первом запуске требует интернета; `DIARIZATION_MODEL` позволяет
указать путь к заранее скачанному локальному каталогу модели.

Проверки декодирования, временных меток и сопоставления говорящих без скачивания
моделей (при установленных основных зависимостях):

```powershell
python -m unittest discover -s tests -v
```
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
