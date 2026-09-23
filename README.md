# Локальное распознавание русского и казахского + NVIDIA NeMo

Конвейер: `аудио → NeMo (голоса и интервалы) → rukk STT → реплики с таймкодами`.
STT использует прежнюю модель смешанной русско-казахской речи. Диаризация —
**NVIDIA NeMo ClusteringDiarizer: multilingual MarbleNet + TitaNet Large**.
Регистрация, `HF_TOKEN`, `hf auth login` и подтверждение доступа к моделям не нужны.

## Локальные данные и модели

Обработка читает веса только из `models/`. Автоматического скачивания при
распознавании нет: при отсутствии файла программа сообщает, что нужно подготовить.
Флаги offline/отключения телеметрии задаются до импорта ML-библиотек.
`prepare_models.py` — отдельная команда подготовки; она не читает аудио, результаты
или `.env`, не использует токены и ничего из проекта не загружает на серверы.

Один раз подготовьте модели на компьютере с интернетом (можно на другом):

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
wsl -d Ubuntu-24.04 -u root --cd "$PWD" --exec bash setup_nemo_wsl.sh
```

После подготовки запускайте из PowerShell:

```powershell
.\run_nemo.ps1
.\run_nemo.ps1 --num-speakers 5
```

Этот запуск использует `unshare --net`: у Python-процесса отдельное сетевое
пространство имён без внешних интерфейсов и маршрутов. Интернет недоступен на
уровне ОС, GPU и локальные папки остаются доступны. Launcher запускается от root
в WSL, поскольку создание сетевого пространства требует соответствующих прав.
Если изоляцию создать не удалось, обработка не запускается.

Далее — ручная установка для другой машины.

Если Ubuntu ещё не установлена, выполните в PowerShell с правами администратора:

```powershell
wsl --install -d Ubuntu-24.04
```

Завершите первоначальную настройку Ubuntu; если Windows попросит — перезагрузитесь.
Затем в терминале **Ubuntu/WSL**, с Python 3.12:

```bash
sudo apt-get update
sudo apt-get install -y python3.12-venv build-essential ffmpeg libsndfile1 sox
python3.12 -m venv ~/venvs/qorit-nemo
source ~/venvs/qorit-nemo/bin/activate
cd /mnt/c/Islam/Involve/hack/hack-618902fe-alabala---tou
python -m pip install --upgrade pip setuptools wheel
python -m pip install -r requirements-nemo.txt
python prepare_models.py --check
python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CUDA unavailable')"
python test.py --diarize
# Если точно известно число говорящих:
python test.py --diarize --num-speakers 5
```

Проект фиксирует совместимую пару `torch==2.11.0+cu130` и
`torchaudio==2.11.0+cu130`; NeMo — `2.7.2`. Нужен поддерживающий CUDA 13 драйвер
NVIDIA на Windows. `torch.cuda.is_available()` должен выводить `True`.
Нейромодели выполняются на CUDA, автоматического перехода на CPU нет.
Декодирование аудиофайлов, подготовка данных и запись результатов используют CPU.

В зависимостях NeMo могут встречаться `pyannote.core` и `pyannote.metrics` — это
структуры данных и метрики. Модели `pyannote.audio`/Community-1 и доступ к ним
проект больше не использует.

## Запуск с запрещённой сетью: Docker

Для изоляции на уровне ОС используйте Linux-контейнер с **`--network none`**.
Настройки offline в библиотеках сами по себе не являются сетевым экраном.
Нужен Docker с поддержкой NVIDIA GPU (на Windows — Docker Desktop с WSL2).
Подготовьте модели и соберите образ, пока есть интернет:

```powershell
docker build -f Dockerfile.nemo -t qorit-nemo .
New-Item -ItemType Directory -Force results | Out-Null
$projectDir = (Get-Location).Path
docker run --rm --gpus all --network none `
  --mount "type=bind,source=$projectDir\models,target=/app/models,readonly" `
  --mount "type=bind,source=$projectDir\media,target=/app/media,readonly" `
  --mount "type=bind,source=$projectDir\results,target=/app/results" `
  qorit-nemo python test.py --diarize --num-speakers 5
```

Аудио, модели, `.env` и результаты исключены из контекста сборки `.dockerignore`.
При обработке контейнер имеет доступ к GPU и указанным локальным папкам, сеть
отключена. Для автоматического определения количества голосов уберите
`--num-speakers 5`. Подготовленный образ можно перенести через `docker save` /
`docker load` вместе с папкой моделей и запускать без интернета.

## Результат и Python API

`test.py --diarize` обрабатывает записи из `media/`, выводит реплики и сохраняет
`results/<имя аудиофайла>.json`. Каталог результата задаётся `--output-dir`.
Иллюстрация формата:

```text
[00:01.200–00:04.500] SPEAKER_00: коллеги начинаем совещание
[00:05.100–00:08.800] SPEAKER_01: біздің бағыт бойынша жоспар орындалды
```

Один файл:

```bash
python stt_kazakh_russian.py "media/Совещание №1.mp3" --diarize --num-speakers 5
```

```python
from stt_kazakh_russian import transcribe, transcribe_diarized

text = transcribe("meeting.wav")  # прежний API: строка
result = transcribe_diarized("meeting.wav", max_speakers=8)
for segment in result["segments"]:
    print(segment["start"], segment["end"], segment["speaker"], segment["text"])
```

Возвращаются `text`, `duration`, `words`, `segments`, `speakers`, `speaker_turns` и
`timestamps_approximate`. Время — секунды от начала записи. Слово назначается голосу
с максимальным пересечением по времени; при равенстве или отсутствии пересечения
получает `speaker: null` (`UNKNOWN` в консоли). Смена интервала/голоса либо пауза
больше 1,5 секунды начинает новую реплику. Слова не удаляются.

Число голосов можно задать точно через `num_speakers` или ограничить сверху через
`max_speakers` (по умолчанию 8). Эти параметры взаимоисключающие. NeMo clustering
не поддерживает нижнюю границу `min_speakers > 1`: такой запрос вызывает понятную
ошибку, используйте точное количество или верхнюю границу.

### Ограничения качества

- TitaNet группирует голоса; распознавание текста на русском/казахском выполняет
  прежняя `rukk`. Качество на смешанной речи нужно оценивать на ваших записях.
- `SPEAKER_00` — голос внутри одной записи. Это ещё не имя человека и не исполнитель
  поручения; для этого нужен отдельный этап сопоставления участников.
- Метки слов приблизительные: вычисляются по CTC-кадрам, без forced alignment.
- Одновременная речь нескольких людей не разделяется на отдельные дорожки.
- Пунктуация и извлечение поручений в этом конвейере не добавляются.

## Длинные записи и память GPU

STT читает аудио окнами: 10 секунд новой речи + до 1 секунды контекста с каждой
стороны. На границах контекст отбрасывается до непрерывного CTC-декодирования.
При CUDA OOM окно уменьшается вплоть до 1 секунды с повтором текущего участка.
Ошибки нехватки памяти при загрузке самих весов требуют освобождения VRAM.

```bash
python stt_kazakh_russian.py "media/Совещание №1.mp3" --chunk-seconds 5 --overlap-seconds 0.5
```

Диаризация временно читает полную волну в RAM, преобразует её в mono 16 kHz WAV
и кластеризует голоса всей записи. Промежуточные WAV/JSON/RTTM удаляются при выходе
из вызова, в том числе при обычной ошибке; после аварийного завершения процесса
они могут остаться в системной временной папке. Это локальные файлы.

Перед NeMo освобождается GPU-кэш предыдущей STT-модели; после NeMo освобождаются
его модели, затем запускается STT. Размер батча NeMo — 8. Запускайте один процесс
обработки на GPU. Окна STT не уменьшают потребление памяти самой диаризацией.

SoundFile/libsndfile читает WAV, FLAC, OGG, MP3 в поддерживаемых сборках.
Неподдерживаемые форматы (например, M4A) предварительно конвертируйте в WAV.

Источники: [NeMo и поддерживаемые платформы](https://pypi.org/project/nemo-toolkit/2.7.2/),
[ClusteringDiarizer: загрузка локальных .nemo](https://github.com/NVIDIA/NeMo/blob/v2.7.2/nemo/collections/asr/models/clustering_diarizer.py),
[модель смешанной русско-казахской речи](https://huggingface.co/alibiserikbay/kazakh-russian-mixed-stt),
[PyTorch CUDA 13.0](https://pytorch.org/get-started/previous-versions/#v2110).

---

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

`Teams/Zoom/Meet или запись → локальный rukk STT → локальный NVIDIA NeMo → локальная LLM → QORIT → PDF/DOCX/СЭД`.

В `server.py` реализован автономный демонстрационный адаптер без зависимостей. В production его заменяют self-hosted STT, диаризация и LLM — параметры уже вынесены в `.env`. Аудио и текст не уходят во внешние API.
