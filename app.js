/* Same-origin audio API; optional text-only rules and review stay in the browser. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const input = $('#manualTranscript');
  const analyze = $('#analyzeBtn');
  const status = $('#analysisStatus');
  let result = null;
  let busy = false;
  let selectedAudio = null;
  let audioNeedsTranscript = false;
  let audioUrl = null;
  let recorder = null;
  let recordingStarted = 0;
  let animationFrame = null;
  let audioContext = null;
  let recordingPending = false;
  let importedUtterances = null;
  let sourceDirty = false;
  let manualEdits = false;
  let removedTask = null;
  let saveTimer = null;
  let saved = true;
  let unsavedRecording = false;
  let apiState = 'checking';
  let apiConfig = null;
  let audioRequest = null;
  const draftKey = 'qorit.draft.v1';
  const today = () => {
    const date = new Date();
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  };
  $('#meetingDate').value = today();

  function taskToday() {
    if (result?.reportTimezone) {
      try {
        const parts = new Intl.DateTimeFormat('en-CA', {timeZone: result.reportTimezone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date());
        return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
      } catch { /* Imported unknown timezones fall back to the device calendar. */ }
    }
    return today();
  }
  function uploadIssue() {
    if (!selectedAudio) return '';
    if (!/\.(mp3|wav|flac|ogg|m4a|webm)$/i.test(selectedAudio.name)) return 'Сервер принимает MP3, WAV, FLAC, OGG, M4A и WebM. Преобразуйте другой формат локально.';
    if (apiConfig && selectedAudio.size > apiConfig.max_upload_bytes) return 'Файл больше лимита сервера (' + Math.floor(apiConfig.max_upload_bytes / 1024 / 1024) + ' МБ).';
    return '';
  }

  const example = [
    'Данияр Серикович (руководитель): Коллеги, обсудим поставки и запуск.',
    'Ботагоз Нурлановна (производство): Выпуск продукции — 94% от плана. Поставка сырья задерживается на 7 дней, линия простаивает.',
    'Данияр Серикович: Ерлан, подготовь претензию поставщику до конца недели.',
    'Ерлан (юрист): Принял, подготовлю претензию.',
    'Данияр Серикович: Ботагоз Нурлановна, найдите альтернативного поставщика за две недели.',
    'Ботагоз Нурлановна: Хорошо, сделаем.',
    'Жандос Талгатович (инвестиции): Освоено 68% бюджета. Подрядчики задерживают документацию.',
    'Данияр Серикович: Жандос Талгатович, соберите совещание с подрядчиками на этой неделе.',
    'Жандос Талгатович: На этой неделе организуем.',
    'Айжан: Бүгін чек-листті жаңартамын. Итоговый отчёт отправлю до пятницы.'
  ].join('\n');

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function message(text, isError = false) {
    status.textContent = text;
    status.classList.toggle('error', isError);
  }
  function updateButton() {
    const recording = recordingPending || recorder?.state === 'recording';
    analyze.disabled = busy || recording || !input.value.trim() || audioNeedsTranscript;
    const unavailable = !result?.utterances.length || sourceDirty || busy || audioNeedsTranscript;
    $$('[data-export]').forEach(button => { button.disabled = unavailable; });
    $('#addTask').disabled = unavailable;
    $('#copyBtn').disabled = unavailable;
    $('#undoTask').disabled = busy;
    $('#saveDraft').disabled = busy || (!input.value.trim() && !result);
    $('#loadDemo').disabled = busy || recording;
    $('#importBtn').disabled = busy || recording;
    $('#openDraft').disabled = busy || recording;
    $('#uploadBtn').disabled = busy || recording;
    input.readOnly = busy;
    $('#processAudioBtn').disabled = busy || recording || apiState !== 'ready' || !selectedAudio || Boolean(uploadIssue());
    $('#clearAudioBtn').disabled = busy || recording || !selectedAudio;
    $('#cancelProcessing').hidden = !audioRequest;
    $('#checkApi').disabled = apiState === 'checking' || busy;
    $('#diarizeAudio').disabled = busy;
    $('#numSpeakers').disabled = busy || !$('#diarizeAudio').checked;
    $('#meetingDate').disabled = busy;
    $('#recordBtn').disabled = busy || recordingPending;
    $$('#taskList input, #taskList select, #taskList textarea, #taskList button, #peopleList input, #peopleList button').forEach(control => {
      if (busy) {
        if (!control.hasAttribute('data-busy-disabled')) control.dataset.busyDisabled = String(control.disabled);
        control.disabled = true;
      } else if (control.hasAttribute('data-busy-disabled')) {
        control.disabled = control.dataset.busyDisabled === 'true';
        delete control.dataset.busyDisabled;
      }
    });
    if (sourceDirty && result) $('#exportStatus').textContent = 'Исходник изменён. Сначала обработайте его заново; экспорт предыдущего результата заблокирован.';
  }
  async function checkBackend() {
    if (busy) return;
    apiState = 'checking';
    $('#apiStatus').textContent = 'Проверяю HTTP API…';
    updateButton();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      apiConfig = await window.QoritApi.getConfig({signal: controller.signal});
      apiState = 'ready';
      if (!$('#diarizeAudio').dataset.userChanged) $('#diarizeAudio').checked = apiConfig.default_diarize;
      $('#apiStatus').textContent = 'API доступен на ' + window.location.origin + '. Лимит: ' + Math.floor(apiConfig.max_upload_bytes / 1024 / 1024) + ' МБ, ' + Math.floor(apiConfig.max_audio_seconds / 60) + ' мин. Модели проверяются при обработке записи.';
      if (uploadIssue()) message(uploadIssue(), true);
    } catch (error) {
      apiState = 'unavailable';
      $('#apiStatus').textContent = 'API недоступен. Откройте страницу с адреса запущенного server.py (обычно порт 8000), а не Live Server. ' + (controller.signal.aborted ? 'Время проверки истекло.' : error.message);
    } finally { clearTimeout(timeout); updateButton(); }
  }
  function applyReport(adapted) {
    result = adapted.result;
    input.value = adapted.sourceText;
    importedUtterances = result.utterances;
    sourceDirty = false;
    manualEdits = false;
    audioNeedsTranscript = false;
    removedTask = null;
    $('#undoTask').hidden = true;
    $('#taskFilter').value = 'all';
    $('#exportStatus').textContent = '';
    $('#audioProgress').hidden = !audioRequest;
    if (adapted.metadata.meetingDate) $('#meetingDate').value = adapted.metadata.meetingDate;
    render();
    changed();
    activateTab('protocol');
  }
  async function processAudio() {
    if (busy || recordingPending || recorder?.state === 'recording') return;
    if (!selectedAudio || apiState !== 'ready') { message('Выберите запись и проверьте доступность API.', true); return; }
    if (uploadIssue()) { message(uploadIssue(), true); return; }
    const diarize = $('#diarizeAudio').checked;
    const speakers = $('#numSpeakers').value.trim();
    if (diarize && speakers && (!/^\d{1,3}$/.test(speakers) || Number(speakers) < 1 || Number(speakers) > 100)) { message('Число говорящих должно быть целым от 1 до 100.', true); return; }
    if (!$('#meetingDate').value || !$('#meetingDate').checkValidity()) { message('Укажите действительную дату совещания, чтобы сервер правильно определил относительные сроки.', true); return; }
    if (manualEdits && !window.confirm('Серверный анализ заменит текущие ручные правки. Сначала сохраните JSON, если они нужны. Продолжить?')) return;
    busy = true;
    const controller = new AbortController();
    audioRequest = controller;
    let timedOut = false;
    const started = Date.now();
    const progress = $('#audioProgress');
    progress.hidden = false;
    const showProgress = () => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      progress.textContent = 'Отправка и обработка на сервере… ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') + '. API возвращает результат целиком; отдельные стадии и проценты недоступны.';
    };
    showProgress();
    const ticker = setInterval(showProgress, 1000);
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30 * 60 * 1000);
    updateButton();
    $('#processAudioBtn').textContent = 'Обработка на сервере…';
    message('Отправляю запись в /process-audio. Не закрывайте страницу.');
    try {
      const adapted = await window.QoritApi.processAudio(selectedAudio, {
        meetingDate: $('#meetingDate').value, diarize, numSpeakers: diarize && speakers ? Number(speakers) : undefined
      }, {signal: controller.signal});
      if (controller.signal.aborted) return;
      applyReport(adapted);
      message('Получен результат сервера: ' + result.utterances.length + ' реплик, ' + result.tasks.length + ' поручений. Проверьте имена, цитаты и сроки.');
      progress.textContent = 'Ответ API получен. Правки и экспорт выполняются в браузере; повторное распознавание для экспорта не требуется.';
    } catch (error) {
      const reason = controller.signal.aborted
        ? (timedOut ? 'Время ожидания истекло (30 минут).' : 'Ожидание отменено.') + ' Сервер мог продолжить обработку — отмена в API не предусмотрена. Результат не получен.'
        : 'Обработка записи не выполнена: ' + error.message;
      message(reason, true);
      progress.textContent = reason;
    } finally {
      clearInterval(ticker);
      clearTimeout(timeout);
      audioRequest = null;
      busy = false;
      $('#processAudioBtn').textContent = '✦ Распознать аудио';
      updateButton();
    }
  }
  function metadata() { return {title: $('#meetingTitle').value.trim() || 'Протокол совещания', meetingDate: $('#meetingDate').value}; }
  function draft() { return {type: 'qorit-draft', version: 1, sourceText: input.value, sourceDirty: sourceDirty || audioNeedsTranscript, importedUtterances, metadata: metadata(), result}; }
  function persistNow() {
    clearTimeout(saveTimer);
    if (!$('#persistDraft').checked) return;
    try {
      localStorage.setItem(draftKey, window.QoritStorage.serialize(draft()));
      saved = true;
      $('#storageStatus').textContent = 'Черновик сохранён в этом браузере. Аудиозапись не сохраняется.';
    } catch (error) {
      saved = false;
      $('#storageStatus').textContent = 'Не удалось сохранить черновик: хранилище недоступно, переполнено или данные слишком велики. Скачайте JSON. ' + error.message;
    }
  }
  function changed() {
    saved = false;
    if ($('#persistDraft').checked) {
      $('#storageStatus').textContent = 'Есть несохранённые изменения…';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persistNow, 300);
    }
  }
  function download(data, type, filename) {
    const url = URL.createObjectURL(new Blob([data], {type}));
    const link = element('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function restoreDraft(value) {
    $('#audioProgress').hidden = true;
    input.value = value.sourceText;
    importedUtterances = value.importedUtterances;
    sourceDirty = value.sourceDirty;
    result = value.result;
    $('#meetingTitle').value = value.metadata.title || 'Протокол совещания';
    $('#meetingDate').value = value.metadata.meetingDate || today();
    audioNeedsTranscript = false;
    manualEdits = Boolean(result);
    removedTask = null;
    $('#undoTask').hidden = true;
    $('#taskFilter').value = 'all';
    if (result) render();
    else clearResult();
    updateButton();
  }
  function clearResult() {
    $('#analysisOrigin').textContent = '';
    $('#summaryLabel').textContent = 'СВОДКА ПРОТОКОЛА';
    $('#summaryText').textContent = 'После обработки здесь появятся сводка и предупреждения из результата.';
    ['#summaryHighlights', '#summaryDecisions', '#peopleList'].forEach(id => $(id).replaceChildren());
    ['#highlightsTitle', '#decisionsTitle', '#analysisStats', '#taskDashboard', '#reminderBanner'].forEach(id => { $(id).hidden = true; });
    $('#analysisWarnings').textContent = '';
    $('#transcriptList').replaceChildren(element('p', 'empty-state', 'Расшифровка ещё не обработана.'));
    $('#taskList').replaceChildren(element('p', 'empty-state', 'Сначала обработайте расшифровку.'));
    $('#taskCount').textContent = $('#sideTaskCount').textContent = '0';
    $('#copyBtn').disabled = true;
  }
  function taskChanged() {
    manualEdits = true;
    renderStats();
    renderDashboard();
    changed();
  }
  const stateLabels = {done: 'Выполнено', overdue: 'Просрочено', upcoming: 'Срок в ближайшие 3 дня', working: 'В работе', undated: 'Без точной даты'};
  function renderDashboard() {
    if (!result) return;
    const asOf = taskToday();
    const counts = window.QoritMeeting.summarizeTasks(result.tasks, asOf);
    const dashboard = $('#taskDashboard');
    dashboard.hidden = false;
    dashboard.replaceChildren();
    for (const [key, label] of [['total', 'Всего'], ['overdue', 'Просрочено'], ['upcoming', 'Скоро срок'], ['done', 'Выполнено']]) {
      const tile = element('div', 'count-' + key);
      tile.append(element('b', '', String(counts[key])), element('span', '', label));
      dashboard.append(tile);
    }
    const reminder = $('#reminderText');
    const reminderText = 'Напоминание: просрочено — ' + counts.overdue + ', срок в ближайшие 3 дня — ' + counts.upcoming + '. Дата: ' + asOf + (result.reportTimezone ? ' (' + result.reportTimezone + ')' : ' (устройство)') + '.';
    if (reminder.textContent !== reminderText) reminder.textContent = reminderText;
    $('#reminderBanner').hidden = !counts.overdue && !counts.upcoming;
    $$('.task-detail').forEach(card => {
      const task = result.tasks[Number(card.dataset.index)];
      if (!task) return;
      const state = window.QoritMeeting.dateState(task, asOf);
      const badge = card.querySelector('.due-badge');
      badge.textContent = stateLabels[state];
      badge.className = 'due-badge state-' + state;
      const filter = $('#taskFilter').value;
      card.hidden = filter !== 'all' && (filter === 'review' ? !task.needsReview : filter === 'working' ? state === 'done' : filter !== state);
    });
    const visible = $$('.task-detail').filter(card => !card.hidden).length;
    $('#taskStatus').textContent = 'Показано: ' + visible + ' из ' + result.tasks.length + '. Без точной даты: ' + counts.undated + '.';
  }
  function activateTab(name) {
    if (!['protocol', 'tasks', 'people'].includes(name)) return;
    $$('.tab-content').forEach(section => {
      const active = section.id === name;
      section.hidden = !active;
      section.classList.toggle('active', active);
    });
    $$('.tabs [data-tab]').forEach(button => {
      const active = button.dataset.tab === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $$('[data-view]').forEach(link => {
      const active = link.dataset.view === name;
      link.classList.toggle('side-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }
  function showSource(index) {
    activateTab('protocol');
    const node = document.getElementById('utterance-' + index);
    if (!node) return;
    $$('.source-highlight').forEach(item => item.classList.remove('source-highlight'));
    node.classList.add('source-highlight');
    node.tabIndex = -1;
    node.focus({preventScroll: true});
    node.scrollIntoView({block: 'center', behavior: 'smooth'});
  }
  function renderStats() {
    const stats = $('#analysisStats');
    stats.hidden = false;
    stats.replaceChildren();
    [
      [result.utterances.length, 'реплик'],
      [result.people.length, 'говорящих'],
      [result.tasks.length, 'поручений'],
      [result.tasks.filter(task => task.needsReview).length, 'на проверке']
    ].forEach(([count, label]) => {
      const tile = element('div');
      tile.append(element('b', '', String(count)), element('span', '', label));
      stats.append(tile);
    });
  }
  function renderTasks() {
    const list = $('#taskList');
    list.replaceChildren();
    if (!result.tasks.length) {
      list.append(element('p', 'empty-state', 'Явные поручения не найдены. Проверьте исходный текст: действие, ответственный и срок могут быть не сформулированы.'));
      return;
    }
    result.tasks.forEach((task, index) => {
      const card = element('article', 'task task-detail');
      card.dataset.index = index;
      const heading = element('div', 'task-heading');
      heading.append(element('h3', '', 'Поручение ' + (index + 1)));
      const badge = element('span', 'review-badge', task.needsReview ? 'Нужно проверить' : task.reviewed ? 'Проверено' : 'Извлечено из текста');
      heading.append(badge, element('span', 'due-badge'));
      const exclude = element('button', 'secondary', 'Исключить');
      exclude.type = 'button';
      exclude.setAttribute('aria-label', 'Исключить поручение ' + (index + 1));
      exclude.addEventListener('click', () => {
        removedTask = {task, index};
        result.tasks = result.tasks.filter(item => item !== task);
        $('#taskCount').textContent = result.tasks.length;
        $('#sideTaskCount').textContent = result.tasks.length;
        $('#undoTask').hidden = false;
        renderTasks();
        taskChanged();
      });
      heading.append(exclude);
      card.append(heading);
      const titleLabel = element('label', 'task-title-label', 'Суть поручения');
      const titleInput = element('textarea');
      titleInput.value = task.title;
      titleInput.rows = 2;
      titleInput.maxLength = 20000;
      titleInput.setAttribute('aria-label', 'Суть поручения ' + (index + 1));
      function markForReview() {
        task.needsReview = true;
        task.reviewed = false;
        badge.textContent = 'Изменено · проверьте';
        confirm.disabled = false;
        confirm.textContent = 'Подтвердить поручение';
        taskChanged();
      }
      titleInput.addEventListener('input', () => { task.title = titleInput.value.trim(); markForReview(); });
      titleLabel.append(titleInput);
      card.append(titleLabel);
      const fields = element('div', 'task-fields');
      for (const [key, title] of [['owner', 'Ответственный'], ['due', 'Срок']]) {
        const label = element('label', '', title);
        const field = element('input');
        field.type = 'text';
        field.maxLength = 2500;
        field.value = task[key] || 'Не указан';
        field.setAttribute('aria-label', title + ' поручения ' + (index + 1));
        field.addEventListener('input', () => {
          task[key] = field.value.trim() || 'Не указан';
          if (key === 'due') { task.dueDate = ''; dateInput.value = ''; }
          markForReview();
        });
        label.append(field);
        fields.append(label);
      }
      const dateLabel = element('label', '', 'Точная дата для напоминания');
      const dateInput = element('input');
      dateInput.type = 'date';
      dateInput.value = task.dueDate || '';
      dateInput.setAttribute('aria-label', 'Точная дата поручения ' + (index + 1));
      dateInput.addEventListener('change', () => { task.dueDate = dateInput.value; markForReview(); });
      dateLabel.append(dateInput);
      fields.append(dateLabel);
      const statusLabel = element('label', '', 'Статус');
      const select = element('select');
      select.setAttribute('aria-label', 'Статус поручения ' + (index + 1));
      ['В работе', 'Выполнено'].forEach(value => {
        const option = element('option', '', value);
        option.value = value;
        select.append(option);
      });
      select.value = task.status || 'В работе';
      select.addEventListener('change', () => { task.status = select.value; taskChanged(); });
      statusLabel.append(select);
      fields.append(statusLabel);
      card.append(fields);
      if (task.urgency || task.direction) {
        const urgency = {high: 'Высокая', medium: 'Средняя', low: 'Низкая'};
        const direction = {finance: 'Финансы', legal: 'Юридическое', procurement: 'Закупки', production: 'Производство', safety: 'Безопасность', hr: 'Персонал', it: 'ИТ', general: 'Общее'};
        card.append(element('p', 'assignment-basis', 'Классификация сервера: срочность — ' + (urgency[task.urgency] || 'не указана') + '; направление — ' + (direction[task.direction] || 'не указано') + '.'));
      }
      if (task.assignmentBasis) card.append(element('p', 'assignment-basis', 'При извлечении: ' + task.assignmentBasis));
      const confirm = element('button', 'secondary', 'Подтвердить поручение');
      confirm.type = 'button';
      confirm.disabled = task.reviewed && !task.needsReview;
      if (confirm.disabled) confirm.textContent = '✓ Подтверждено';
      confirm.addEventListener('click', () => {
        if (!task.title.trim() || window.QoritMeeting.isUnassigned(task.owner)) {
          $('#taskStatus').textContent = 'Укажите суть поручения и настоящее имя ответственного. Анонимную метку нужно уточнить на вкладке «Участники».';
          return;
        }
        if (!task.dueDate && (!task.due?.trim() || /^(?:не указан|—)$/iu.test(task.due.trim()))) {
          $('#taskStatus').textContent = 'Уточните срок поручения. Если срока действительно нет, явно укажите «Без срока».';
          return;
        }
        task.needsReview = false;
        task.reviewed = true;
        badge.textContent = 'Проверено';
        confirm.textContent = '✓ Подтверждено';
        confirm.disabled = true;
        taskChanged();
      });
      card.append(confirm);
      const details = element('details', 'task-evidence');
      details.append(element('summary', '', 'Исходная цитата'));
      if (task.sourceSpeaker) details.append(element('p', 'assignment-basis', 'Говорящий: ' + task.sourceSpeaker + '. Автор реплики не обязательно исполнитель поручения.'));
      details.append(element('blockquote', '', task.source || 'Цитата не найдена.'));
      if (Number.isInteger(task.sourceIndex)) {
        const link = element('button', 'secondary', 'К реплике');
        link.type = 'button';
        link.addEventListener('click', () => showSource(task.sourceIndex));
        details.append(link);
      }
      card.append(details);
      list.append(card);
    });
    renderDashboard();
  }
  function render() {
    $('#summaryText').textContent = result.summary;
    $('#summaryLabel').textContent = result.method === 'server' ? 'СВОДКА ОТВЕТА СЕРВЕРА' : 'КРАТКОЕ САММАРИ · ПРАВИЛА';
    $('#analysisOrigin').textContent = result.method === 'server'
      ? 'Источник поручений: сервер · ' + (result.analysisMethod || 'метод не указан') + '. Исходный отчёт: ' + (result.reportDate || 'дата не указана') + '. Ручные правки сохраняются только в браузере.'
      : 'Источник: локальные языковые правила в браузере, без запроса к Ollama.';
    for (const [key, listId, titleId] of [
      ['highlights', '#summaryHighlights', '#highlightsTitle'],
      ['decisions', '#summaryDecisions', '#decisionsTitle']
    ]) {
      const list = $(listId);
      list.replaceChildren();
      const values = result[key] || [];
      $(titleId).hidden = !values.length;
      values.forEach(text => list.append(element('li', '', text)));
    }
    $('#analysisWarnings').textContent = (result.warnings || []).join(' ');
    const list = $('#transcriptList');
    list.replaceChildren();
    result.utterances.forEach((item, index) => {
      const node = $('#utterance').content.cloneNode(true);
      node.querySelector('.utterance').id = 'utterance-' + index;
      node.querySelector('time').textContent = item.time || '—';
      node.querySelector('i').textContent = item.speaker.split(/\s+/).map(word => word[0]).join('').slice(0, 2);
      node.querySelector('b').textContent = item.speaker;
      if (item.originalSpeaker) node.querySelector('b').textContent += ' · ' + item.originalSpeaker;
      node.querySelector('p').textContent = item.text;
      list.append(node);
    });
    if (!result.utterances.length) list.append(element('p', 'empty-state', 'Сервер не вернул распознанной речи. Проверьте запись; текст не был подставлен автоматически.'));
    $('#peopleList').replaceChildren();
    result.people.forEach(([name, role]) => {
      const card = element('article', 'person');
      card.append(element('b', '', name), element('span', '', role));
      const nameLabel = element('label', '', 'Имя участника');
      const nameInput = element('input');
      nameInput.value = window.QoritMeeting.isUnassigned(name) ? '' : name;
      nameInput.maxLength = 80;
      nameInput.placeholder = 'Введите настоящее имя';
      nameInput.setAttribute('aria-label', 'Имя для ' + name);
      nameLabel.append(nameInput);
      const rename = element('button', 'secondary', 'Применить имя');
      rename.type = 'button';
      const feedback = element('p', 'muted');
      feedback.setAttribute('role', 'status');
      rename.addEventListener('click', () => {
        try {
          result = window.QoritMeeting.renameSpeaker(result, name, nameInput.value);
          taskChanged();
          render();
          message('Имя обновлено в репликах и поручениях с этим именем. Неизвестные исполнители не назначаются по автору реплики — проверьте их отдельно.');
        } catch (error) { feedback.textContent = error.message; }
      });
      card.append(nameLabel, rename, feedback);
      $('#peopleList').append(card);
    });
    if (!result.people.length) $('#peopleList').append(element('p', 'empty-state', 'Имена говорящих в тексте не указаны.'));
    $('#taskCount').textContent = result.tasks.length;
    $('#sideTaskCount').textContent = result.tasks.length;
    renderStats();
    $('#copyBtn').disabled = !result.utterances.length;
    renderTasks();
    renderDashboard();
    updateButton();
  }
  async function processText() {
    const source = input.value.trim();
    if (busy) return;
    if (!source || audioNeedsTranscript) {
      message(selectedAudio ? 'Для выбранной записи нужна расшифровка. Вставьте её в поле выше.' : 'Добавьте текст совещания.', true);
      input.focus();
      return;
    }
    if ((manualEdits || result?.method === 'server') && !window.confirm('Разбор по правилам заменит серверные поручения и ручные правки. Это отдельный режим без ИИ. Продолжить? При необходимости сначала сохраните JSON.')) return;
    busy = true;
    updateButton();
    analyze.textContent = 'Разбираю расшифровку…';
    message('Выделяю реплики, поручения и ключевые вопросы…');
    try {
      // Give the browser a frame to display the actual processing state.
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      if (!window.QoritAnalyzer) throw new Error('Модуль обработки не загрузился. Обновите страницу.');
      // Reject server placeholders even when pasted manually into the editor.
      window.QoritMeeting.parseImport(source, 'transcript.txt');
      const next = window.QoritAnalyzer.analyzeTranscript(importedUtterances || source);
      result = next;
      sourceDirty = false;
      manualEdits = false;
      removedTask = null;
      $('#undoTask').hidden = true;
      $('#taskFilter').value = 'all';
      $('#exportStatus').textContent = '';
      render();
      changed();
      activateTab('protocol');
      message('Разобрано по правилам браузера (без ИИ): ' + next.utterances.length + ' реплик, ' + next.tasks.length + ' поручений. Проверьте вкладку «Поручения».');
    } catch (error) {
      message('Не удалось обработать текст: ' + error.message, true);
    } finally {
      busy = false;
      analyze.textContent = 'Разобрать текст по правилам';
      updateButton();
    }
  }
  function stopVisualization() {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    if (audioContext) audioContext.close().catch(() => {});
    animationFrame = null;
    audioContext = null;
    $$('.wave span').forEach(bar => { bar.style.height = '4px'; });
  }
  function showSelectedAudio(file) {
    if (!file.size) { message('Выбран пустой файл записи.', true); return; }
    selectedAudio = file;
    audioNeedsTranscript = true;
    $('#audioProgress').hidden = true;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(file);
    const download = $('#recordDownload');
    download.href = audioUrl;
    download.download = file.name;
    download.hidden = false;
    download.textContent = 'Скачать: ' + file.name;
    $('#recordPlayer').src = audioUrl;
    $('#recordPlayer').hidden = false;
    $('#selectedAudioInfo').textContent = file.name + ' · ' + (file.size / 1024 / 1024).toFixed(2) + ' МБ';
    message(uploadIssue() || 'Запись выбрана. Нажмите «Распознать аудио», чтобы отправить её на сервер этого приложения.' + (result ? ' До получения ответа ниже остаётся предыдущий протокол.' : ''), Boolean(uploadIssue()));
    updateButton();
  }
  async function toggleRecording() {
    if (recordingPending) return;
    if (recorder?.state === 'recording') {
      $('#recordBtn').disabled = true;
      recorder.stop();
      return;
    }
    if (unsavedRecording && !window.confirm('Новая запись заменит предыдущую в памяти. Сначала скачайте её, если она нужна. Продолжить?')) return;
    if (!$('#recordConsent').checked) {
      message('Перед записью уведомите участников, получите необходимое согласие и отметьте подтверждение у кнопки записи.', true);
      $('#recordConsent').focus();
      return;
    }
    let stream;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        throw new Error('Запись требует поддерживаемого браузера и HTTPS или localhost.');
      }
      recordingPending = true;
      $('#recordBtn').disabled = true;
      updateButton();
      stream = await navigator.mediaDevices.getUserMedia({audio: true});
      const current = new MediaRecorder(stream);
      recorder = current;
      const parts = [];
      let failed = false;
      let recordingBytes = 0;
      current.addEventListener('dataavailable', event => {
        if (event.data.size) { parts.push(event.data); recordingBytes += event.data.size; }
        if (recordingBytes > 250 * 1024 * 1024 && current.state === 'recording') current.stop();
      });
      current.addEventListener('stop', () => {
        stream.getTracks().forEach(track => track.stop());
        stopVisualization();
        $('#recordBtn').disabled = false;
        $('#recordBtn').textContent = '● Новая запись';
        $('.meeting-card').classList.add('stopped');
        $('#recordStatus').textContent = 'Запись остановлена';
        $('#recordConsent').disabled = false;
        $('#recordConsent').checked = false;
        const extension = current.mimeType.includes('mp4') ? 'm4a' : 'webm';
        if (!failed && parts.length) {
          unsavedRecording = true;
          showSelectedAudio(new File(parts, 'meeting-' + today() + '.' + extension, {type: current.mimeType}));
        }
        else message('Запись не получена. Проверьте микрофон и попробуйте снова.', true);
        updateButton();
      });
      current.addEventListener('error', () => {
        failed = true;
        stream.getTracks().forEach(track => track.stop());
        stopVisualization();
        $('#recordBtn').disabled = false;
        $('#recordBtn').textContent = '● Новая запись';
        $('#recordStatus').textContent = 'Ошибка записи';
        $('#recordConsent').disabled = false;
        $('.meeting-card').classList.add('stopped');
        message('Запись прервана браузером. Попробуйте снова.', true);
        updateButton();
      });
      current.start(1000);
      $('#recordConsent').disabled = true;
      recordingStarted = performance.now();
      $('#recordBtn').textContent = '■ Остановить запись';
      $('#recordStatus').textContent = '● LIVE · запись идёт';
      $('.meeting-card').classList.remove('stopped');
      const bars = $$('.wave span');
      let meter = null;
      let samples = null;
      try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        meter = audioContext.createAnalyser();
        meter.fftSize = 128;
        audioContext.createMediaStreamSource(stream).connect(meter);
        samples = new Uint8Array(meter.frequencyBinCount);
      } catch { /* Recording continues if the optional level meter is unavailable. */ }
      function tick() {
        if (current.state !== 'recording') return;
        const seconds = Math.floor((performance.now() - recordingStarted) / 1000);
        $('#recordTimer').textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
        if (meter) {
          meter.getByteFrequencyData(samples);
          bars.forEach((bar, index) => { bar.style.height = Math.max(4, samples[index * 3] / 255 * 56) + 'px'; });
        }
        animationFrame = requestAnimationFrame(tick);
      }
      tick();
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      message(error.name === 'NotAllowedError' ? 'Доступ к микрофону не разрешён. Можно загрузить готовую запись.' : error.message, true);
    } finally {
      recordingPending = false;
      $('#recordBtn').disabled = false;
      updateButton();
    }
  }
  $$('.tabs [data-tab]').forEach((button, index, buttons) => {
    button.addEventListener('click', () => activateTab(button.dataset.tab));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      activateTab(buttons[target].dataset.tab);
      buttons[target].focus();
    });
  });
  $$('[data-view]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); activateTab(link.dataset.view); }));
  input.addEventListener('input', () => {
    audioNeedsTranscript = false;
    importedUtterances = null;
    sourceDirty = Boolean(result);
    updateButton();
    changed();
    if (result) message('Текст изменён. Кнопка «Разобрать текст по правилам» создаст новый результат без ИИ. Для серверного анализа повторно отправьте аудио.');
  });
  analyze.addEventListener('click', processText);
  $('#loadDemo').addEventListener('click', () => {
    input.value = example;
    audioNeedsTranscript = false;
    importedUtterances = null;
    sourceDirty = Boolean(result);
    updateButton();
    changed();
    message('Текстовый пример загружен. Для демонстрации без backend нажмите «Разобрать текст по правилам».');
    input.focus();
  });
  $('#copyBtn').addEventListener('click', async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.utterances.map(item => item.speaker + ': ' + item.text).join('\n\n'));
      message('Разделённые реплики скопированы.');
    } catch { message('Браузер не разрешил копирование. Можно выделить текст вручную.', true); }
  });
  $('#uploadBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', event => {
    const file = event.target.files[0];
    if (file && (!unsavedRecording || window.confirm('Выбранный файл заменит несохранённую запись в памяти. Продолжить?'))) {
      unsavedRecording = false;
      showSelectedAudio(file);
    }
    event.target.value = '';
  });
  $('#recordBtn').addEventListener('click', toggleRecording);
  $('#recordDownload').addEventListener('click', () => { unsavedRecording = false; });
  $('#processAudioBtn').addEventListener('click', processAudio);
  $('#checkApi').addEventListener('click', checkBackend);
  $('#cancelProcessing').addEventListener('click', () => audioRequest?.abort());
  $('#diarizeAudio').addEventListener('change', () => { $('#diarizeAudio').dataset.userChanged = 'true'; updateButton(); });
  $('#clearAudioBtn').addEventListener('click', () => {
    if (busy) return;
    if (unsavedRecording && !window.confirm('Убрать запись из памяти? Сначала скачайте её, если она нужна.')) return;
    selectedAudio = null;
    audioNeedsTranscript = false;
    unsavedRecording = false;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null;
    $('#recordPlayer').pause();
    $('#recordPlayer').removeAttribute('src');
    $('#recordPlayer').hidden = true;
    $('#recordDownload').hidden = true;
    $('#recordDownload').removeAttribute('href');
    $('#selectedAudioInfo').textContent = 'Запись не выбрана. Допустимы MP3, WAV, FLAC, OGG, M4A, WebM.';
    $('#audioProgress').hidden = true;
    message('Выбор записи отменён. Текст и предыдущий протокол не изменены.');
    updateButton();
  });
  $('.wave').replaceChildren(...Array.from({length: 10}, () => element('span')));
  $$('[data-export]').forEach(button => button.addEventListener('click', () => {
    if (!result || sourceDirty || audioNeedsTranscript || busy) return;
    try {
      const exportResult = {...result, tasks: result.tasks.map(task => ({...task, status: window.QoritMeeting.dateState(task, taskToday()) === 'overdue' ? 'Просрочено' : task.status}))};
      if (button.dataset.export === 'docx') {
        download(window.QoritExport.createDocx(exportResult, metadata()), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'qorit-' + ($('#meetingDate').value || today()) + '.docx');
        $('#exportStatus').textContent = 'DOCX текущего протокола подготовлен к скачиванию. Проверьте загрузки браузера.';
      } else {
        const html = window.QoritExport.createPrintHtml(exportResult, metadata());
        const popup = window.open('', '_blank');
        if (!popup) throw new Error('Браузер заблокировал окно печати. Разрешите всплывающее окно для этого сайта.');
        popup.opener = null;
        popup.document.open();
        popup.document.write(html);
        popup.document.close();
        popup.document.getElementById('print-protocol').addEventListener('click', () => popup.print());
        $('#exportStatus').textContent = 'Открыт текущий протокол. Нажмите «Печать / сохранить PDF», затем выберите «Сохранить как PDF». Ничего не отправляется на сервер.';
      }
    } catch (error) { $('#exportStatus').textContent = 'Экспорт не выполнен: ' + error.message; }
  }));
  $('#importBtn').addEventListener('click', () => $('#transcriptInput').click());
  $('#transcriptInput').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file || busy) return;
    busy = true;
    updateButton();
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Файл больше 20 МБ. Разделите расшифровку на части.');
      const contents = await file.text();
      if (/\.json$/i.test(file.name)) {
        const report = JSON.parse(contents.replace(/^\uFEFF/, ''));
        if (report && typeof report === 'object' && Object.hasOwn(report, 'transcript')) {
          const adapted = window.QoritApi.fromReport(report);
          if (manualEdits && !window.confirm('Импорт отчёта API заменит текущие ручные правки. Продолжить?')) return;
          applyReport(adapted);
          message('Отчёт API импортирован: поручения взяты из файла без повторного анализа по правилам.');
          return;
        }
      }
      const parsed = window.QoritMeeting.parseImport(contents, file.name);
      input.value = parsed.sourceText;
      importedUtterances = parsed.utterances;
      audioNeedsTranscript = false;
      sourceDirty = Boolean(result);
      changed();
      message('Расшифровка загружена. Для отдельного текстового режима нажмите «Разобрать текст по правилам».' + (parsed.timestampsApproximate ? ' Таймкоды STT приблизительные.' : ''));
    } catch (error) { message('Импорт не выполнен: ' + error.message, true); }
    finally { busy = false; updateButton(); }
  });
  $('#taskFilter').addEventListener('change', renderDashboard);
  $('#viewReminders').addEventListener('click', () => { activateTab('tasks'); $('#taskFilter').value = 'all'; renderDashboard(); $('#taskDashboard').scrollIntoView({block: 'start'}); });
  $('#addTask').addEventListener('click', () => {
    if (!result) return;
    result.tasks.push({id: Date.now(), title: '', owner: 'Не указан', due: 'Не указан', dueDate: '', status: 'В работе', needsReview: true, source: '', sourceIndex: null, assignmentBasis: 'Добавлено вручную; укажите суть, ответственного и срок.'});
    $('#taskFilter').value = 'all';
    render();
    taskChanged();
    $('#taskList').lastElementChild?.querySelector('textarea')?.focus();
  });
  $('#undoTask').addEventListener('click', () => {
    if (!result || !removedTask) return;
    result.tasks.splice(removedTask.index, 0, removedTask.task);
    removedTask = null;
    $('#undoTask').hidden = true;
    render();
    taskChanged();
  });
  $('#meetingTitle').addEventListener('input', changed);
  $('#meetingDate').addEventListener('change', () => {
    if (result?.method === 'server') {
      sourceDirty = true;
      message('Дата совещания изменена. Повторите серверную обработку аудио: сроки прежнего результата рассчитаны от старой даты.', true);
      updateButton();
    }
    changed();
  });
  $('#persistDraft').addEventListener('change', () => {
    if ($('#persistDraft').checked) persistNow();
    else {
      clearTimeout(saveTimer);
      try {
        localStorage.removeItem(draftKey);
        saved = false;
        $('#storageStatus').textContent = 'Автосохранение выключено, сохранённая копия удалена. Текущий протокол остаётся в памяти вкладки.';
      } catch { $('#storageStatus').textContent = 'Не удалось удалить сохранённую копию: хранилище недоступно. Удалите данные этого сайта в настройках браузера.'; }
    }
  });
  $('#forgetDraft').addEventListener('click', () => {
    if (!window.confirm('Удалить сохранённый в этом браузере черновик QORIT? Текущий открытый протокол останется в памяти вкладки.')) return;
    $('#persistDraft').checked = false;
    $('#persistDraft').dispatchEvent(new Event('change'));
  });
  $('#saveDraft').addEventListener('click', () => {
    try {
      download(window.QoritStorage.serialize(draft()), 'application/json', 'qorit-draft-' + today() + '.json');
      $('#storageStatus').textContent = 'JSON подготовлен к скачиванию. Он содержит расшифровку и персональные данные, но не аудио.';
    } catch (error) { $('#storageStatus').textContent = 'Не удалось сохранить JSON: ' + error.message; }
  });
  $('#openDraft').addEventListener('click', () => $('#draftInput').click());
  $('#draftInput').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file || busy) return;
    busy = true;
    updateButton();
    try {
      if (file.size > window.QoritStorage.MAX_BYTES) throw new Error('Черновик больше допустимого размера (' + Math.floor(window.QoritStorage.MAX_BYTES / 1024 / 1024) + ' МБ).');
      const next = window.QoritStorage.parse(await file.text());
      if ((result || input.value.trim()) && !window.confirm('Открытый черновик заменит текущий текст и правки. Продолжить?')) return;
      restoreDraft(next);
      changed();
      message(next.sourceDirty ? 'Черновик открыт. Исходный текст изменён — обработайте его для обновления результата.' : 'Черновик открыт вместе с правками и статусами поручений.');
    } catch (error) { $('#storageStatus').textContent = 'Не удалось открыть черновик: ' + error.message; }
    finally { busy = false; updateButton(); }
  });
  try {
    const stored = localStorage.getItem(draftKey);
    if (stored) {
      restoreDraft(window.QoritStorage.parse(stored));
      $('#persistDraft').checked = true;
      $('#storageStatus').textContent = 'Восстановлен сохранённый в этом браузере черновик. Автосохранение включено.';
      message('Черновик восстановлен. Проверьте вкладки «Поручения» и «Участники».');
    }
  } catch { $('#storageStatus').textContent = 'Хранилище браузера недоступно или черновик повреждён. Работа продолжается в памяти; используйте JSON для сохранения.'; }
  const remindersTimer = setInterval(renderDashboard, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderDashboard(); else persistNow(); });
  window.addEventListener('beforeunload', event => {
    persistNow();
    if ((!saved && (result || input.value.trim())) || unsavedRecording || audioRequest || recorder?.state === 'recording') { event.preventDefault(); event.returnValue = ''; }
  });
  updateButton();
  checkBackend();
  window.addEventListener('pagehide', event => {
    recorder?.stream.getTracks().forEach(track => track.stop());
    stopVisualization();
    // A BFCache return resumes the same document: keep its timer and media URL.
    if (!event.persisted) {
      audioRequest?.abort();
      clearInterval(remindersTimer);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    }
  });
})();
