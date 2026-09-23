/* Frontend-only import, identity review and calendar helpers. No network or storage. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QoritMeeting = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_TEXT = 200000;
  const MAX_SEGMENTS = 5000;
  const UNKNOWN = 'Не указан';
  const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const nameKey = value => compact(value).toLocaleLowerCase('ru').replace(/ё/g, 'е');

  function isUnassigned(name) {
    if (name == null || !compact(name)) return true;
    return /^(?:не\s+указан(?:а)?|не\s+определ[её]н(?:а)?|неизвест(?:ен|на|ный|ная)?(?:\s+(?:участник|спикер|говорящий))?|(?:участник|спикер|говорящий|speaker)[\s_#-]*\d*|unknown|undefined|null|none|[—–?-])$/iu.test(compact(name));
  }

  function checkText(value, label) {
    if (typeof value !== 'string') throw new Error(`${label}: ожидается строка текста.`);
    if (value.length > MAX_TEXT) throw new Error(`Расшифровка превышает ${MAX_TEXT} символов. Разделите её на части.`);
    const text = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!text) throw new Error(`${label}: текст пуст.`);
    if (/^Аудиофайл(?:\s|:)[\s\S]*успешно обработан/iu.test(text)) {
      throw new Error('Сервер вернул уведомление об обработке файла, а не расшифровку речи. Нужен результат STT.');
    }
    return text;
  }

  function formatTime(seconds) {
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remaining = total % 60;
    const parts = [minutes, remaining].map(value => String(value).padStart(2, '0'));
    if (hours) parts.unshift(String(hours).padStart(2, '0'));
    return parts.join(':');
  }

  function parseImport(input, fileName = 'transcript.txt') {
    if (typeof input !== 'string') throw new Error('Файл должен содержать текст UTF-8.');
    if (/\.txt$/i.test(fileName)) return {sourceText: checkText(input, 'Расшифровка'), utterances: null, timestampsApproximate: false};
    if (!/\.json$/i.test(fileName)) throw new Error('Выберите расшифровку .txt или результат STT .json.');
    let data;
    try { data = JSON.parse(input.replace(/^\uFEFF/, '')); }
    catch (_) { throw new Error('Некорректный JSON: проверьте содержимое файла.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Ожидается JSON-объект с text или segments.');
    if (data.text !== undefined && typeof data.text !== 'string') throw new Error('Поле text должно быть строкой.');
    if (data.text?.length > MAX_TEXT) throw new Error(`Расшифровка превышает ${MAX_TEXT} символов. Разделите её на части.`);
    if (data.text?.trim()) checkText(data.text, 'Поле text');
    if (data.duration !== undefined && (typeof data.duration !== 'number' || !Number.isFinite(data.duration) || data.duration < 0)) {
      throw new Error('Поле duration должно быть конечным неотрицательным числом.');
    }
    if (!Object.prototype.hasOwnProperty.call(data, 'segments')) {
      return {sourceText: checkText(data.text, 'Поле text'), utterances: null, timestampsApproximate: data.timestamps_approximate === true};
    }
    if (!Array.isArray(data.segments) || !data.segments.length) throw new Error('Поле segments должно содержать непустой массив реплик.');
    if (data.segments.length > MAX_SEGMENTS) throw new Error(`В файле больше ${MAX_SEGMENTS} реплик. Разделите запись на части.`);
    let characters = 0;
    const utterances = data.segments.map((item, index) => {
      const label = `Реплика ${index + 1}`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label}: ожидается объект.`);
      if (typeof item.start !== 'number' || typeof item.end !== 'number' || !Number.isFinite(item.start)
        || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start) {
        throw new Error(`${label}: некорректные start/end (секунды).`);
      }
      if (data.duration !== undefined && item.end > data.duration + 0.001) throw new Error(`${label}: конец реплики позже длительности записи.`);
      const text = checkText(item.text, label);
      characters += text.length;
      if (characters > MAX_TEXT) throw new Error(`Расшифровка превышает ${MAX_TEXT} символов. Разделите её на части.`);
      if (item.speaker !== undefined && item.speaker !== null && (typeof item.speaker !== 'string'
        || item.speaker.length > 80 || /[\r\n\u0000-\u001F\u007F]/u.test(item.speaker))) {
        throw new Error(`${label}: некорректная метка говорящего.`);
      }
      return {time: formatTime(item.start), speaker: compact(item.speaker) || UNKNOWN, text, start: item.start, end: item.end};
    });
    const sourceText = utterances.map(item => `[${item.time}] ${item.speaker}: ${item.text}`).join('\n');
    if (sourceText.length > MAX_TEXT) throw new Error(`Расшифровка с метками превышает ${MAX_TEXT} символов. Разделите её на части.`);
    return {sourceText, utterances, timestampsApproximate: data.timestamps_approximate === true};
  }

  function calendarDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1) return null;
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date.getTime() / 86400000;
  }

  function localToday() {
    const now = new Date();
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  }

  function dateState(task, today = localToday(), reminderDays = 3) {
    if (task?.status === 'Выполнено' || task?.status === 'done') return 'done';
    const due = calendarDay(task?.dueDate);
    if (due === null) return 'undated';
    const current = calendarDay(today);
    if (current === null) throw new Error('Некорректная текущая дата: ожидается YYYY-MM-DD.');
    if (!Number.isInteger(reminderDays) || reminderDays < 0) throw new Error('Период напоминания должен быть целым неотрицательным числом дней.');
    const difference = due - current;
    if (difference < 0) return 'overdue';
    return difference <= reminderDays ? 'upcoming' : 'working';
  }

  function summarizeTasks(tasks, today = localToday()) {
    if (!Array.isArray(tasks)) throw new Error('Ожидается список поручений.');
    const result = {total: tasks.length, working: 0, upcoming: 0, overdue: 0, done: 0, undated: 0};
    tasks.forEach(task => { result[dateState(task, today)] += 1; });
    return result;
  }

  function renameSpeaker(result, oldName, newName) {
    if (typeof newName !== 'string' || /[\r\n\u0000-\u001F\u007F]/u.test(newName)) throw new Error('Имя должно быть одной строкой.');
    const name = compact(newName);
    if (!name || isUnassigned(name)) throw new Error('Укажите настоящее имя участника, а не номер говорящего.');
    if (name.length > 80) throw new Error('Имя участника не должно превышать 80 символов.');
    if (!result || !Array.isArray(result.people) || !Array.isArray(result.utterances) || !Array.isArray(result.tasks)) {
      throw new Error('Сначала сформируйте протокол.');
    }
    const existing = new Set([...result.people.map(item => item[0]), ...result.utterances.map(item => item.speaker), ...result.tasks.map(item => item.owner)]);
    if (!existing.has(oldName)) throw new Error('Исходный участник не найден.');
    if ([...existing].some(value => value !== oldName && nameKey(value) === nameKey(name))) {
      throw new Error('Участник с таким именем уже есть. Автоматическое объединение говорящих запрещено.');
    }
    // Preserve literal evidence and initial labels: renaming does not establish voice identity.
    const tasks = result.tasks.map(task => task.owner === oldName
      ? {...task, owner: name, originalOwner: task.originalOwner || oldName, needsReview: true, reviewed: false}
      : {...task});
    return {
      ...result,
      people: result.people.map(item => item[0] === oldName
        ? [name, isUnassigned(oldName) ? 'Имя указано пользователем (' + oldName + ')' : item[1]]
        : [...item]),
      utterances: result.utterances.map(item => item.speaker === oldName
        ? {...item, speaker: name, originalSpeaker: item.originalSpeaker || oldName}
        : {...item}),
      tasks,
      warnings: Array.isArray(result.warnings) ? [...result.warnings] : [],
      stats: {...result.stats, needsReview: tasks.filter(task => task.needsReview).length}
    };
  }

  return {parseImport, isUnassigned, dateState, summarizeTasks, renameSpeaker, localToday};
}));
