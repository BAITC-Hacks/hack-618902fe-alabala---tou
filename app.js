/* The analyzer and all transcript data stay in this browser. */
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
    analyze.disabled = busy || recordingPending || recorder?.state === 'recording' || !input.value.trim() || audioNeedsTranscript;
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
      const heading = element('div', 'task-heading');
      heading.append(element('h3', '', (index + 1) + '. ' + task.title));
      const badge = element('span', 'review-badge', task.needsReview ? 'Нужно проверить' : 'Извлечено из текста');
      heading.append(badge);
      const exclude = element('button', 'secondary', 'Исключить');
      exclude.type = 'button';
      exclude.setAttribute('aria-label', 'Исключить поручение ' + (index + 1));
      exclude.addEventListener('click', () => {
        result.tasks = result.tasks.filter(item => item !== task);
        $('#taskCount').textContent = result.tasks.length;
        $('#sideTaskCount').textContent = result.tasks.length;
        renderStats();
        renderTasks();
      });
      heading.append(exclude);
      card.append(heading);
      const fields = element('div', 'task-fields');
      for (const [key, title] of [['owner', 'Ответственный'], ['due', 'Срок']]) {
        const label = element('label', '', title);
        const field = element('input');
        field.type = 'text';
        field.value = task[key] || 'Не указан';
        field.setAttribute('aria-label', title + ' поручения ' + (index + 1));
        field.addEventListener('change', () => {
          task[key] = field.value.trim() || 'Не указан';
          field.value = task[key];
          task.needsReview = true;
          badge.textContent = 'Изменено · проверьте';
          confirm.disabled = false;
          confirm.textContent = 'Подтвердить поручение';
          renderStats();
        });
        label.append(field);
        fields.append(label);
      }
      const statusLabel = element('label', '', 'Статус');
      const select = element('select');
      select.setAttribute('aria-label', 'Статус поручения ' + (index + 1));
      ['В работе', 'Выполнено'].forEach(value => {
        const option = element('option', '', value);
        option.value = value;
        select.append(option);
      });
      select.value = task.status || 'В работе';
      select.addEventListener('change', () => { task.status = select.value; });
      statusLabel.append(select);
      fields.append(statusLabel);
      card.append(fields);
      if (task.assignmentBasis) card.append(element('p', 'assignment-basis', 'При извлечении: ' + task.assignmentBasis));
      const confirm = element('button', 'secondary', 'Подтвердить поручение');
      confirm.type = 'button';
      confirm.addEventListener('click', () => {
        task.needsReview = false;
        badge.textContent = 'Проверено';
        confirm.textContent = '✓ Подтверждено';
        confirm.disabled = true;
        renderStats();
      });
      card.append(confirm);
      const details = element('details', 'task-evidence');
      details.append(element('summary', '', 'Исходная цитата'));
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
  }
  function render() {
    $('#summaryText').textContent = result.summary;
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
      node.querySelector('p').textContent = item.text;
      list.append(node);
    });
    $('#peopleList').replaceChildren();
    result.people.forEach(([name, role]) => {
      const card = element('article', 'person');
      card.append(element('b', '', name), element('span', '', role));
      $('#peopleList').append(card);
    });
    if (!result.people.length) $('#peopleList').append(element('p', 'empty-state', 'Имена говорящих в тексте не указаны.'));
    $('#taskCount').textContent = result.tasks.length;
    $('#sideTaskCount').textContent = result.tasks.length;
    renderStats();
    $('#copyBtn').disabled = !result.utterances.length;
    renderTasks();
  }
  async function processText() {
    const source = input.value.trim();
    if (busy) return;
    if (!source || audioNeedsTranscript) {
      message(selectedAudio ? 'Для выбранной записи нужна расшифровка. Вставьте её в поле выше.' : 'Добавьте текст совещания.', true);
      input.focus();
      return;
    }
    busy = true;
    updateButton();
    analyze.textContent = 'Разбираю расшифровку…';
    message('Выделяю реплики, поручения и ключевые вопросы…');
    try {
      // Give the browser a frame to display the actual processing state.
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      if (!window.QoritAnalyzer) throw new Error('Модуль обработки не загрузился. Обновите страницу.');
      const next = window.QoritAnalyzer.analyzeTranscript(source);
      result = next;
      render();
      activateTab('protocol');
      message('Обработано: ' + next.utterances.length + ' реплик, ' + next.tasks.length + ' поручений. Ответственные и сроки доступны на вкладке «Поручения».');
    } catch (error) {
      message('Не удалось обработать текст: ' + error.message, true);
    } finally {
      busy = false;
      analyze.textContent = '✦ Обработать текст';
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
    selectedAudio = file;
    audioNeedsTranscript = true;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(file);
    const download = $('#recordDownload');
    download.href = audioUrl;
    download.download = file.name;
    download.hidden = false;
    download.textContent = 'Скачать: ' + file.name;
    message('Выбрана запись «' + file.name + '». Вставьте её расшифровку: аудиораспознавание на этом экране не подключено.');
    updateButton();
  }
  async function toggleRecording() {
    if (recordingPending) return;
    if (recorder?.state === 'recording') {
      $('#recordBtn').disabled = true;
      recorder.stop();
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
      current.addEventListener('dataavailable', event => { if (event.data.size) parts.push(event.data); });
      current.addEventListener('stop', () => {
        stream.getTracks().forEach(track => track.stop());
        stopVisualization();
        $('#recordBtn').disabled = false;
        $('#recordBtn').textContent = '● Новая запись';
        $('.meeting-card').classList.add('stopped');
        $('#recordStatus').textContent = 'Запись остановлена';
        const extension = current.mimeType.includes('mp4') ? 'm4a' : 'webm';
        showSelectedAudio(new File(parts, 'meeting.' + extension, {type: current.mimeType}));
        updateButton();
      });
      current.addEventListener('error', () => {
        stream.getTracks().forEach(track => track.stop());
        stopVisualization();
        message('Запись прервана браузером. Попробуйте снова.', true);
      });
      current.start();
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
    updateButton();
    if (result) message('Исходный текст изменён. Нажмите «Обработать текст», чтобы обновить результат.');
  });
  analyze.addEventListener('click', processText);
  $('#loadDemo').addEventListener('click', () => {
    input.value = example;
    audioNeedsTranscript = false;
    updateButton();
    message('Пример загружен. Нажмите «Обработать текст».');
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
    if (file) showSelectedAudio(file);
  });
  $('#recordBtn').addEventListener('click', toggleRecording);
  $('.wave').replaceChildren(...Array.from({length: 10}, () => element('span')));
  $$('[data-export]').forEach(button => button.addEventListener('click', () => {
    // The existing backend exports a fixed demo, not the current analysis.
    $('#exportStatus').textContent = 'Экспорт текущего результата ещё не подключён. Серверный экспорт содержит демо-данные; они не соответствуют этому протоколу.';
  }));
  window.addEventListener('pagehide', () => {
    recorder?.stream.getTracks().forEach(track => track.stop());
    stopVisualization();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  });
})();
