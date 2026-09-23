/* Same-origin transport and an explicit adapter for server.py's report schema. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QoritApi = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_TEXT = 2000000;
  const MAX_SEGMENTS = 20000;
  const MAX_TASKS = 5000;
  const UNKNOWN = 'Не указан';
  const EXTENSIONS = Object.freeze(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.webm']);
  const compact = text => text.replace(/\s+/gu, ' ').trim();
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isAnonymous = value => /^(?:не\s+указан(?:а)?|не\s+определ[её]н(?:а)?|неизвест(?:ен|на|ный|ная)?(?:\s+(?:участник|спикер|говорящий))?|(?:участник|спикер|говорящий|speaker)[\s_#-]*\d*|unknown|undefined|null|none|я|мы|мен|біз|[—–?-])$/iu.test(value.trim());
  const invalid = field => new Error(`Некорректный ответ backend: ${field}. Результат не опубликован; проверьте совместимость server.py и интерфейса.`);

  function string(value, field, limit = MAX_TEXT, {nullable = false, empty = true} = {}) {
    if (nullable && value === null) return null;
    if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw invalid(field);
    return value;
  }

  function isoDate(value, field, optional = false) {
    if (optional && (value === undefined || value === null || value === '')) return '';
    string(value, field, 10, {empty: false});
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith('0000')) throw invalid(field);
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw invalid(field);
    return value;
  }

  function timeLabel(seconds) {
    const n = Math.floor(seconds);
    return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
      : `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  }

  function stringList(value, field) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 1000) throw invalid(field);
    return value.map((item, index) => string(item, `${field}[${index}]`, 10000, {empty: false}));
  }

  function fromReport(report) {
    if (!isObject(report) || !isObject(report.transcript)) throw invalid('transcript');
    const transcript = report.transcript;
    const fullText = string(transcript.text, 'transcript.text');
    const segments = transcript.segments === undefined ? [] : transcript.segments;
    if (!Array.isArray(segments) || segments.length > MAX_SEGMENTS) throw invalid('transcript.segments');
    const warnings = stringList(report.warnings, 'warnings');
    const people = new Map();
    let totalSegmentText = 0;
    const utterances = segments.map((segment, index) => {
      const field = `transcript.segments[${index}]`;
      if (!isObject(segment)) throw invalid(field);
      const text = string(segment.text, `${field}.text`);
      totalSegmentText += text.length;
      if (totalSegmentText > MAX_TEXT) throw invalid('суммарная длина сегментов превышает 2 000 000 символов');
      const label = segment.speaker === undefined ? null : string(segment.speaker, `${field}.speaker`, 200, {nullable: true});
      const speaker = label?.trim() || UNKNOWN;
      const timing = {};
      if (segment.start !== undefined || segment.end !== undefined) {
        if (typeof segment.start !== 'number' || typeof segment.end !== 'number'
          || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
          || segment.start < 0 || segment.end < segment.start) throw invalid(`${field}: временные метки`);
        timing.start = segment.start;
        timing.end = segment.end;
      }
      if (text.trim() && speaker !== UNKNOWN) people.set(speaker, isAnonymous(speaker) ? 'Метка голоса: сопоставьте с участником' : 'Имя из результата backend; проверьте участника');
      return {time: timing.start === undefined ? '—' : timeLabel(timing.start), speaker, text, ...timing};
    }).filter(item => item.text.trim());

    const combinedText = utterances.map(item => item.text).join(' ');
    const sourceText = fullText.trim() ? fullText : combinedText;
    if (fullText.trim() && (!utterances.length || compact(combinedText) !== compact(fullText))) {
      if (utterances.length) {
        warnings.push('Метки говорящих не покрывают полный текст: сохранена полная расшифровка без привязки к участнику. Неполная сегментация не используется.');
        utterances.length = 0;
        people.clear();
      }
      else warnings.push('Backend вернул расшифровку без сегментов говорящих. Диаризация этого результата недоступна.');
      utterances.push({time: '—', speaker: UNKNOWN, text: fullText, isFullTranscript: true});
    }
    if (!sourceText.trim()) warnings.push('Backend не распознал речь. Проверьте запись и настройки распознавания.');
    if ([...people.keys()].some(isAnonymous)) warnings.push('SPEAKER и другие метки голоса не являются именами. Сопоставьте их с участниками вручную; личность по голосу не установлена.');

    if (!Array.isArray(report.tasks) || report.tasks.length > MAX_TASKS) throw invalid('tasks');
    const ids = new Set();
    const tasks = report.tasks.map((raw, index) => {
      const field = `tasks[${index}]`;
      if (!isObject(raw)) throw invalid(field);
      const id = raw.id === undefined ? `server-task-${index + 1}` : string(raw.id, `${field}.id`, 100, {empty: false});
      if (ids.has(id)) throw invalid(`${field}: повторяющийся id`);
      ids.add(id);
      const title = string(raw.title, `${field}.title`, 500, {empty: false});
      const assignee = string(raw.assignee, `${field}.assignee`, 2500, {nullable: true, empty: false});
      const owner = assignee || UNKNOWN;
      const dueDate = isoDate(raw.deadline, `${field}.deadline`, raw.deadline === null);
      const deadlineText = string(raw.deadline_text, `${field}.deadline_text`, 2500, {nullable: true, empty: false});
      const source = string(raw.source_quote, `${field}.source_quote`, 2500, {empty: false});
      const sourceSpeaker = string(raw.source_speaker, `${field}.source_speaker`, 200, {nullable: true, empty: false});
      if (!['in_progress', 'overdue', 'completed'].includes(raw.status)) throw invalid(`${field}.status`);
      if (!['high', 'medium', 'low'].includes(raw.urgency)) throw invalid(`${field}.urgency`);
      if (!['finance', 'legal', 'procurement', 'production', 'safety', 'hr', 'it', 'general'].includes(raw.direction)) throw invalid(`${field}.direction`);
      if (typeof raw.needs_review !== 'boolean') throw invalid(`${field}.needs_review`);
      // Exact normalized containment, not fuzzy guessing or a speaker-to-owner inference.
      const quote = compact(source);
      if (!compact(sourceText).includes(quote) && !compact(combinedText).includes(quote)) throw invalid(`${field}: исходная цитата отсутствует в расшифровке`);
      const candidates = utterances.map((item, candidateIndex) => ({item, candidateIndex}))
        .filter(({item}) => (!sourceSpeaker || item.speaker === sourceSpeaker) && compact(item.text).includes(quote));
      const sourceIndex = candidates.length === 1 ? candidates[0].candidateIndex : null;
      const needsReview = raw.needs_review || isAnonymous(owner) || !dueDate;
      return {
        id, title, owner, due: deadlineText || dueDate || UNKNOWN, dueDate,
        status: raw.status === 'completed' ? 'Выполнено' : 'В работе', serverStatus: raw.status,
        source, sourceIndex, sourceSpeaker, needsReview, reviewed: false,
        assignmentBasis: assignee ? 'Ответственный извлечён backend из цитаты; проверьте имя и срок.' : 'Backend не установил ответственного. Говорящий не назначается исполнителем автоматически.',
        urgency: raw.urgency, direction: raw.direction
      };
    });

    const analysisMethod = report.analysis_method === undefined ? 'Не указан backend' : string(report.analysis_method, 'analysis_method', 200, {empty: false});
    const meetingDate = isoDate(report.meeting_date, 'meeting_date', true);
    const reportDate = isoDate(report.as_of, 'as_of', true);
    const reportTimezone = report.timezone === undefined ? '' : string(report.timezone, 'timezone', 100, {empty: false});
    if (reportTimezone) {
      try { new Intl.DateTimeFormat('ru', {timeZone: reportTimezone}).format(); }
      catch (_) { throw invalid('timezone'); }
    }
    const filename = report.filename === undefined ? '' : string(report.filename, 'filename', 1000);
    const generatedAt = report.generated_at === undefined ? '' : string(report.generated_at, 'generated_at', 100);
    const summary = report.summary === undefined || report.summary === null
      ? `Сервер выделил поручений: ${tasks.length}. Развёрнутое саммари backend не возвращает.`
      : string(report.summary, 'summary', 100000, {empty: false});
    const result = {
      summary, highlights: stringList(report.highlights, 'highlights'), decisions: stringList(report.decisions, 'decisions'),
      utterances, people: [...people], tasks, warnings: [...new Set(warnings)],
      method: 'server', analysisMethod, reportDate, reportTimezone,
      stats: {utterances: utterances.length, participants: people.size, tasks: tasks.length,
        needsReview: tasks.filter(item => item.needsReview).length, characters: sourceText.length}
    };
    return {result, sourceText, metadata: {meetingDate, filename, asOf: reportDate, timezone: reportTimezone, generatedAt, analysisMethod}};
  }

  const STATUS_ERRORS = {
    400: 'Проверьте аудиофайл и параметры обработки.',
    404: 'Маршрут backend не найден. Откройте интерфейс по адресу server.py, а не через Live Server или другой порт.',
    405: 'Этот сервер не поддерживает нужный API. Откройте интерфейс через server.py.',
    413: 'Файл или длительность записи превышает ограничение сервера.',
    415: 'Формат записи не поддерживается. Используйте MP3, WAV, FLAC, OGG, M4A или WebM.',
    422: 'Не удалось прочитать запись: проверьте файл, кодек и длительность.',
    500: 'Ошибка backend. Подробности доступны в журнале server.py.',
    502: 'Backend не смог получить корректный результат распознавания или анализа.',
    503: 'Обработка временно недоступна: сервер занят либо не готовы CUDA, модели, FFmpeg или llama.cpp.'
  };

  async function requestJSON(path, init, {fetchImpl = globalThis.fetch, signal} = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('Браузер не поддерживает fetch. Используйте современный браузер.');
    let response;
    try { response = await fetchImpl(path, {...init, cache: 'no-store', credentials: 'same-origin', signal}); }
    catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      throw new Error('Не удалось связаться с backend. Проверьте, что server.py запущен, и откройте интерфейс с того же адреса и порта.');
    }
    let payload = null;
    try {
      const body = await response.text();
      if (body.length > 32000000) throw new Error('Ответ backend слишком большой. Попробуйте более короткую запись.');
      if (/^\s*[{[]/u.test(body)) {
        try { payload = JSON.parse(body); } catch (_) { /* A schema-specific error below, never an HTML alert. */ }
      }
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      if (error?.message?.includes('слишком большой')) throw error;
      throw new Error('Соединение прервано при получении результата. Проверьте журнал backend; запрос автоматически не повторяется.');
    }
    if (!response.ok) {
      const explanation = STATUS_ERRORS[response.status] || `Ошибка backend (HTTP ${response.status}).`;
      const detail = isObject(payload) && typeof payload.error === 'string' ? payload.error.trim().slice(0, 1500) : '';
      throw new Error(detail ? `${explanation} ${detail}` : explanation);
    }
    if (!isObject(payload)) throw new Error('Backend вернул не JSON-отчёт. Проверьте адрес: страница должна быть открыта через server.py, а не Live Server.');
    if (typeof payload.error === 'string') throw new Error(`Backend сообщил об ошибке: ${payload.error.slice(0, 1500)}`);
    return payload;
  }

  async function processAudio(file, options = {}, requestOptions = {}) {
    if (!(file instanceof Blob) || file.size === 0) throw new Error('Выберите непустой аудиофайл или запишите звук.');
    const filename = typeof file.name === 'string' ? file.name : options.filename;
    if (typeof filename !== 'string' || !EXTENSIONS.some(extension => filename.toLowerCase().endsWith(extension))) throw new Error('Неподдерживаемый формат. Допустимы MP3, WAV, FLAC, OGG, M4A, WebM.');
    const form = new FormData();
    form.append('audio', file, filename);
    if (options.meetingDate) {
      try { form.append('meeting_date', isoDate(options.meetingDate, 'meeting_date')); }
      catch (_) { throw new Error('Укажите существующую дату совещания в формате YYYY-MM-DD.'); }
    }
    if (options.diarize !== undefined) {
      if (typeof options.diarize !== 'boolean') throw new Error('Параметр диаризации должен быть true или false.');
      form.append('diarize', String(options.diarize));
    }
    if (options.numSpeakers !== undefined && options.numSpeakers !== null && options.numSpeakers !== '') {
      const text = String(options.numSpeakers);
      if (!/^\d{1,3}$/u.test(text) || Number(text) < 1 || Number(text) > 100) throw new Error('Количество говорящих должно быть целым числом от 1 до 100.');
      if (options.diarize === false) throw new Error('Количество говорящих можно задавать только с включённой диаризацией.');
      form.append('num_speakers', String(Number(text)));
    }
    return fromReport(await requestJSON('/process-audio', {method: 'POST', body: form, headers: {Accept: 'application/json'}}, requestOptions));
  }

  async function getConfig(requestOptions = {}) {
    const config = await requestJSON('/api/config', {headers: {Accept: 'application/json'}}, requestOptions);
    if (!Number.isSafeInteger(config.max_upload_bytes) || config.max_upload_bytes <= 0
      || typeof config.max_audio_seconds !== 'number' || !Number.isFinite(config.max_audio_seconds) || config.max_audio_seconds <= 0
      || typeof config.default_diarize !== 'boolean') throw invalid('настройки /api/config');
    return {max_upload_bytes: config.max_upload_bytes, max_audio_seconds: config.max_audio_seconds, default_diarize: config.default_diarize};
  }

  return Object.freeze({fromReport, processAudio, getConfig, allowedExtensions: EXTENSIONS, maxTextLength: MAX_TEXT});
}));
