# QORIT — протоколирование совещаний

Локальный конвейер: аудио → Kazakh/Russian STT → NeMo-диаризация → llama.cpp (Gemma Q6_K) →
поручения, сводка статусов и классификация → JSON, PDF или DOCX.
Исходные записи и расшифровки не отправляются во внешние сервисы:
`LLAMA_URL` должен указывать на ваш локальный сервер.

## Запуск одной командой в Windows

Для настроенного окружения Ubuntu-24.04 / WSL2 откройте **`start.cmd`** двойным
щелчком или выполните из корня проекта в PowerShell:

```powershell
.\start.cmd
```

Этот файл запускает Gemma 4 12B IT Q6_K и HTTP API в одном WSL-окружении.
PowerShell-скрипты и изменение Execution Policy не нужны. Адрес llama.cpp для API
задаётся автоматически: `http://127.0.0.1:8080`. Ручная настройка шлюза WSL
и Windows Firewall для связи между этими двумя процессами не требуется.

В `.env` укажите `LLAMA_MODEL_PATH` — путь к уже скачанному
`gemma-4-12b-it-Q6_K.gguf`. Можно использовать Windows-путь вида
`C:/models/gemma-4-12b-it-Q6_K.gguf` или путь внутри WSL.
При первом запуске launcher подготавливает официальную CPU-сборку llama.cpp
`b11125` в `.runtime/llama/`: если архив отсутствует, скачивает его (около 17 МБ)
и проверяет SHA-256. Веса модели не скачиваются. Последующие запуски используют
локальные файлы. Для собственной Linux-сборки задайте `LLAMA_SERVER_BINARY`.
По умолчанию Gemma работает на CPU, оставляя GPU для распознавания речи.
Прогрев при старте отключён; первый запрос может выполняться дольше следующих.

Launcher проверяет зависимости, CUDA и локальные модели STT/NeMo, ждёт готовности
Gemma и API и выводит адрес `http://localhost:8000`. Сохраняйте окно открытым;
для остановки обоих процессов нажмите **Ctrl+C**. Журналы:
`results/launcher/llama.log` и `results/launcher/api.log`.
Проверка окружения без запуска серверов: `start.cmd --check`.

Проверочный запрос из второго окна PowerShell, из корня проекта:

```powershell
curl.exe --fail-with-body -X POST http://localhost:8000/process-audio -F "audio=@media/Совещание №1.mp3" -F "meeting_date=2026-09-23" -F "diarize=false"
```

Укажите фактическую дату записи. Ответ содержит `transcript`, `tasks`, `dashboard`.
Фронтенд с ручным вводом текста запускается отдельно через `node serve-frontend.mjs`;
он пока не подключён к аудио API.

Ниже — ручной запуск и подготовка окружения. `start.cmd` использует
`Ubuntu-24.04` и `/opt/qorit-nemo/bin/python`; другие значения можно задать
через переменные окружения Windows `QORIT_WSL_DISTRO` и `QORIT_PYTHON`.

## Ручной запуск API в готовом окружении

Для уже настроенного распознавания в Ubuntu 24.04 / WSL2, из корня проекта:

```bash
/opt/qorit-nemo/bin/python -m pip install -r requirements-server.txt
# Если .env ещё нет:
cp -n .env.example .env
```

### Gemma 4 12B IT Q6_K через llama.cpp (`local_llama`)

В `.env.example` выбран `LLM_PROVIDER=local_llama`. Это подключение к отдельно
запущенному `llama-server` по `/v1/chat/completions`. Python-приложение не загружает
GGUF самостоятельно; `llama-cpp-python` устанавливать не требуется.

Используется квантованный файл
[`gemma-4-12b-it-Q6_K.gguf` от Unsloth](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/blob/main/gemma-4-12b-it-Q6_K.gguf)
и актуальная сборка [llama.cpp](https://github.com/ggml-org/llama.cpp/releases).
Поместите уже скачанный файл в `models/llm/` и из корня проекта запустите:

```powershell
.\run_llama.ps1 -LlamaServer "C:\llama.cpp\llama-server.exe"
```

Если файл находится в другом каталоге, добавьте
`-ModelPath "D:\models\gemma-4-12b-it-Q6_K.gguf"`. Скрипт выбирает именно этот файл,
проверяет его наличие и имя, не скачивает веса. Путь к `llama-server.exe` замените своим;
если он доступен в PATH, параметр `-LlamaServer` можно опустить.

Эквивалентная команда без скрипта, из каталога с `llama-server.exe`:

```powershell
.\llama-server.exe -m "C:\models\gemma-4-12b-it-Q6_K.gguf" --alias gemma-4-12b-it-Q6_K --host 127.0.0.1 --port 8080 --jinja -c 8192 -np 1 -ngl 0
```

Квантование определяется содержимым GGUF, выбранного через `-m`; смена имени API
не меняет квантование загруженной модели. Здесь `-ngl 0` оставляет LLM на CPU,
чтобы её постоянно загруженная модель не занимала VRAM, необходимую STT/NeMo.
Для CUDA-сборки и при достаточном запасе VRAM можно увеличить `-ngl` (число слоёв
на GPU, параметр скрипта `-GpuLayers`); `-ngl 999` запрашивает перенос всех слоёв. `-c 8192` задаёт контекст,
`-np 1` — один слот обработки. Флаги описаны в
[документации llama-server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server).

Настройки приложения:

```dotenv
LLM_PROVIDER=local_llama
LLAMA_URL=http://127.0.0.1:8080
LLAMA_MODEL=gemma-4-12b-it-Q6_K
LLAMA_TIMEOUT=600
```

`LLAMA_MODEL` должен совпадать с `--alias`, это имя API, а не путь к GGUF.
`LLAMA_TIMEOUT` — время ожидания одного фрагмента в секундах. Приложение
запрашивает JSON по схеме и отключает thinking через `enable_thinking=false`.
Дождитесь загрузки модели; проверить сервер можно через
`Invoke-RestMethod http://127.0.0.1:8080/health` в PowerShell.

Если API и llama.cpp работают в одном окружении, используйте адрес выше.
Для `server.py` в WSL с сетью NAT и llama.cpp в Windows запустите llama-server
с `--host 0.0.0.0` (в скрипте `-ListenAddress 0.0.0.0`), разрешите доступ из WSL в Windows Firewall и перед запуском API
укажите адрес Windows со стороны WSL:

```bash
export LLAMA_URL="http://$(ip route show default | awk '{print $3}'):8080"
/opt/qorit-nemo/bin/python server.py
```

При `--host 0.0.0.0` ограничьте доступ к порту в Firewall локальным окружением.
Если llama-server также запущен в WSL, Windows-путь к файлу замените на
`/mnt/c/...`, а в `LLAMA_URL` оставьте `http://127.0.0.1:8080`.

### Запуск HTTP API

После запуска выбранного LLM-сервера, из корня проекта в WSL:

```bash
/opt/qorit-nemo/bin/python server.py
```

Из PowerShell, находясь в корне проекта:

```powershell
wsl -d Ubuntu-24.04 -- /opt/qorit-nemo/bin/python server.py
```

Сервер использует Waitress, по умолчанию слушает `0.0.0.0:8000`. `HOST` и
`PORT` настраиваются в `.env`. Сервер читает `.env`, переменные окружения
имеют приоритет. Для декодирования нужен FFmpeg, для PDF — DejaVu Sans,
Liberation Sans или Arial с русскими и казахскими символами. В Ubuntu:

```bash
sudo apt-get install ffmpeg fonts-dejavu-core
```

## Три эндпоинта

Все принимают **POST multipart/form-data** с одинаковыми полями:

| Поле | Обязательное | Описание |
| --- | --- | --- |
| `audio` | Да | MP3, WAV, FLAC, OGG, M4A или WebM |
| `meeting_date` | Нет | Дата совещания `YYYY-MM-DD` для слов «завтра», «в пятницу» и т. п. По умолчанию текущая дата, с предупреждением в результате |
| `diarize` | Нет | `true` / `false`; по умолчанию `STT_DIARIZE=true` |
| `num_speakers` | Нет | Число говорящих от 1 до 100; только при `diarize=true` |

| Маршрут | Ответ |
| --- | --- |
| `/process-audio` | `application/json` |
| `/process-audio-pdf` | `application/pdf`, файл `meeting-report.pdf` |
| `/process-audio-docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, файл `meeting-report.docx` |

Примеры PowerShell; используйте именно `curl.exe`:

```powershell
curl.exe --fail-with-body -X POST http://localhost:8000/process-audio -F "audio=@media/Совещание №1.mp3" -F "meeting_date=2026-09-23"
curl.exe --fail-with-body -X POST http://localhost:8000/process-audio-pdf -F "audio=@media/Совещание №1.mp3" -F "meeting_date=2026-09-23" -o meeting-report.pdf
curl.exe --fail-with-body -X POST http://localhost:8000/process-audio-docx -F "audio=@media/Совещание №1.mp3" -F "meeting_date=2026-09-23" -o meeting-report.docx
```

В Linux замените `curl.exe` на `curl`. Каждый запрос заново распознаёт и
анализирует переданную запись; идентификатора сохранённого отчёта и кэша нет.
PDF/DOCX используют ту же схему анализа, что и JSON; они содержат сводку,
все поручения с цитатами, предупреждения и полный текст расшифровки.
Файлы для скачивания формируются в памяти; временное аудио удаляется после запроса.

Пример структуры JSON (иллюстрация, не результат реальной записи):

```json
{
  "filename": "meeting.wav",
  "meeting_date": "2026-09-23",
  "as_of": "2026-09-23",
  "timezone": "Asia/Qyzylorda",
  "generated_at": "2026-09-23T10:00:00+00:00",
  "analysis_method": "local_llama:gemma-4-12b-it-Q6_K",
  "transcript": {
    "text": "айгуль подготовьте отчет до завтра",
    "segments": [],
    "duration": 3.2
  },
  "tasks": [{
    "id": "task-0001",
    "title": "Подготовить отчёт",
    "assignee": "айгуль",
    "deadline": "2026-09-24",
    "deadline_text": "до завтра",
    "status": "in_progress",
    "urgency": "high",
    "direction": "finance",
    "source_quote": "айгуль подготовьте отчет до завтра",
    "source_speaker": null,
    "needs_review": false
  }],
  "dashboard": {
    "total": 1,
    "by_status": {"in_progress": 1, "overdue": 0, "completed": 0},
    "by_urgency": {"high": 1, "medium": 0, "low": 0},
    "by_direction": {"finance": 1},
    "needs_review": 0
  },
  "warnings": [
    "Статусы отражают расшифровку и дату отчета; последующие изменения не отслеживаются."
  ]
}
```

`transcript` сохраняет дополнительные данные STT: `words`, `segments`,
`speakers`, `speaker_turns` и `timestamps_approximate`, если они доступны.

## Правила анализа и дашборд

Локальная LLM выделяет поручения из русской, казахской и смешанной речи, включая
распознавание без пунктуации. Python проверяет JSON и наличие цитат в исходном
тексте. Ошибки LLM возвращаются клиенту; демонстрационные результаты
или скрытый переход на другой анализатор не используются.

- `assignee=null`, если имя/роль нельзя подтвердить цитатой. Имя сохраняется
  в форме из записи. `SPEAKER_00` — голос, а не личность.
- `deadline=null`, если срок отсутствует или явно неопределён.
  Относительные даты считаются от `meeting_date`. Поддерживаемые календарные
  выражения перепроверяются кодом; прочие интерпретации модели помечаются
  `needs_review=true`.
- `completed` / «Выполнено» — только при явном сообщении о выполнении в записи.
  Обещание выполнить, отрицание или частичная готовность не означают выполнение.
- `overdue` / «Просрочено» — невыполненное поручение со сроком раньше `as_of`.
  Срок сегодня ещё не просрочен. Остальные поручения — `in_progress` / «В работе».
  Сроки учитываются до календарного дня, не до часа.
- Срочность: `high`, `medium`, `low`. Просроченные и невыполненные задачи
  со сроком в ближайшие два дня получают `high`.
- Направления: `finance` (финансы), `legal` (юридическое),
  `procurement` (закупки), `production` (производство),
  `safety` (безопасность), `hr` (персонал), `it` (ИТ), `general` (прочее).
- `dashboard` — готовые счётчики для интерфейса, рассчитанные по `tasks`.
  Отсутствующие направления не включаются в `by_direction`.
  ID поручений действуют только внутри одного отчёта.

Это снимок на дату обработки. API не хранит базу поручений и не отслеживает
выполнение после совещания. Для исторических записей передавайте реальную дату.
Длинные расшифровки обрабатываются фрагментами с перекрытием: точные повторы
убираются, смысловые повторы и связи между удалёнными фрагментами требуют
проверки. Качество извлечения зависит от ASR и выбранной модели;
`needs_review` не заменяет проверку протокола человеком.

Существующий интерфейс остаётся отдельным локальным анализатором текста
([FRONTEND.md](FRONTEND.md)); его кнопки пока не подключены к этим маршрутам.
В этом бэкенде ровно три маршрута, без раздачи HTML и без отдельных CRUD-методов.

## Ошибки и ограничения ресурсов

Ошибки приложения на всех трёх маршрутах возвращаются как JSON `{"error": "..."}`.
Проверяйте HTTP-статус до сохранения скачанного файла. Отказ до входа в приложение
(например, лимит тела запроса в Waitress или reverse proxy) может возвращаться
обычным текстом, поэтому клиенту следует проверять также `Content-Type`.

| Код | Причина |
| --- | --- |
| 400 | Нет файла, пустой файл/имя, неверная дата или параметры |
| 413 | Превышен размер запроса или длительность аудио |
| 415 | Неподдерживаемое расширение |
| 422 | Повреждённое/нечитаемое аудио или таймаут декодирования |
| 502 | Ошибка llama.cpp, JSON или проверки извлечённых поручений |
| 503 | Занят GPU-конвейер, нет FFmpeg, CUDA, моделей или зависимостей STT |
| 500 | Внутренняя ошибка обработки/экспорта; детали в журнале сервера |

Лимиты в `.env.example`: `MAX_UPLOAD_MB=256`, `MAX_AUDIO_SECONDS=7200`,
`AUDIO_DECODE_TIMEOUT=300`, `LLAMA_TIMEOUT=600` секунд на фрагмент.
Часовой пояс статусов задаёт `APP_TIMEZONE`.

Запускайте **один процесс сервера на GPU**. Запросы распознавания/анализа не
выполняются одновременно: второй получает 503 с `Retry-After: 30`.
После ASR сервер освобождает модель и CUDA-кэш. Отдельный `llama-server` сохраняет
модель в памяти между запросами: при использовании GPU оставьте VRAM для STT/NeMo
или используйте `-ngl 0` для LLM на CPU. Отдельно запущенные процессы
STT/llama.cpp не координируются этим lock.

PDF использует встроенный Unicode TTF. Для нестандартной установки задайте
`REPORT_FONT_PATH` и при необходимости `REPORT_FONT_BOLD_PATH`.
DOCX использует то же семейство шрифта, но не встраивает файл шрифта:
на компьютере читателя желательно установить этот шрифт.

## Настройка распознавания с нуля

STT и NeMo работают на CUDA; CPU-fallback не предусмотрен. Для RTX 5050
`requirements.txt` использует согласованные `torch==2.11.0+cu130` и
`torchaudio==2.11.0+cu130`. Нативный Windows подходит для STT без диаризации;
для NeMo используйте Linux/WSL2 и отдельный Linux Python 3.12.

```powershell
wsl --install -d Ubuntu-24.04
# После первоначальной настройки Ubuntu, из корня проекта:
wsl -d Ubuntu-24.04 -u root -- bash ./setup_nemo_wsl.sh
```

Скрипт устанавливает зависимости и создаёт `/opt/qorit-nemo`.
Не используйте Windows `.venv` из WSL. Проверка CUDA:

```bash
/opt/qorit-nemo/bin/python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
```

До автономной работы подготовьте локальные модели:

```bash
/opt/qorit-nemo/bin/python prepare_models.py --download
/opt/qorit-nemo/bin/python prepare_models.py --check
```

`prepare_models.py` использует публичные NVIDIA NGC / Hugging Face и уже
имеющийся HF-кэш; `--hf-cache` позволяет указать другой кэш.
Загрузка идёт во временный файл, архив проверяется, печатается SHA256.
Вызовы распознавания ничего не скачивают.

```text
models/
  asr/rukk/model.pt
  asr/rukk/tokens.lst
  diarization/marblenet.nemo
  diarization/titanet_large.nemo
```

Другой корень задаётся `LOCAL_MODELS_DIR` и `--models-dir` у подготовки.
Относительные пути считаются от каталога проекта. CLI не читает `.env`;
экспортируйте переменные в оболочке.

```bash
/opt/qorit-nemo/bin/python test.py --diarize --output-dir results/nemo
/opt/qorit-nemo/bin/python test.py --diarize --num-speakers 5
/opt/qorit-nemo/bin/python stt_kazakh_russian.py "media/Совещание №1.mp3" --diarize
```

Без `--diarize` распознаётся только текст. Python API:

```python
from stt_kazakh_russian import transcribe, transcribe_diarized
text = transcribe("meeting.wav", chunk_seconds=10, overlap_seconds=1)
result = transcribe_diarized("meeting.wav", num_speakers=5)
```

ASR читает звук окнами, не загружая всю волну в VRAM; контекст по краям
уменьшает потери на стыках. При CUDA OOM во время inference окно уменьшается
до 1 секунды. OOM при загрузке весов требует освобождения VRAM.
Диаризация использует всю запись в RAM. Таймкоды слов приблизительные;
метки голосов действуют в пределах одной записи и не определяют имена.

## Docker

`Dockerfile.nemo` сохраняет CLI-режим по умолчанию и включает модули API.
Подготовьте образ, локальные модели и выбранный LLM-сервер заранее:

```bash
docker build -f Dockerfile.nemo -t qorit-nemo .
docker run --rm --gpus all --network none -v "$PWD/models:/app/models:ro" -v "$PWD/media:/app/media:ro" -v "$PWD/results:/app/results" qorit-nemo
# API: llama-server должен быть доступен из контейнера, например на Docker Desktop:
docker run --rm --gpus all -p 8000:8000 --env-file .env -e LLM_PROVIDER=local_llama -e LLAMA_URL=http://host.docker.internal:8080 -v "$PWD/models:/app/models:ro" qorit-nemo python server.py
```

В API-режиме не используйте `--network none`: нужен доступ к локальному LLM-серверу.
Для доступа из контейнера llama-server должен слушать доступный интерфейс хоста
(например, `--host 0.0.0.0` с ограничением доступа в Firewall).

## Проверки

```bash
# pypdf нужен только для проверки содержимого PDF:
/opt/qorit-nemo/bin/python -m pip install pypdf
/opt/qorit-nemo/bin/python -m unittest discover -s tests -v
node --test tests/test-transcript-analyzer.cjs
```

Тесты API/анализа подменяют GPU и ответы llama.cpp, проверяют валидацию,
статусы/даты/цитаты, структуру скачанных файлов, UTF-8 и очистку ресурсов.
Отдельная проверка FFmpeg декодирует настоящие WAV и WebM.
Для оценки качества модели нужен дополнительный запуск на реальных совещаниях.
