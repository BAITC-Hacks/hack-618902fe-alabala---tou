/* Versioned, strictly validated browser drafts. No audio or credentials. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QoritStorage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_BYTES = 20 * 1024 * 1024;
  const MAX_CHARACTERS = 2000000;
  function text(value, max = MAX_CHARACTERS) {
    if (typeof value !== 'string' || value.length > max) throw new Error('Некорректный или слишком длинный текст в черновике.');
    return value;
  }
  function array(value, max) {
    if (!Array.isArray(value) || value.length > max) throw new Error('Некорректный список в черновике.');
    return value;
  }
  function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректный объект в черновике.');
    return value;
  }
  function optionalText(source, key, max, nullable = false) {
    return source[key] === undefined ? {} : {[key]: source[key] === null && nullable ? null : text(source[key], max)};
  }
  function taskId(value, fallback) {
    if (value === undefined) return fallback;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value === 'string' && value.trim()) return text(value, 200);
    throw new Error('Некорректный идентификатор поручения в черновике.');
  }
  function utterances(value) {
    const items = array(value, 20000).map(item => {
      record(item);
      const turn = {time: text(item.time || '—', 30), speaker: text(item.speaker, 200), text: text(item.text)};
      if (item.isFullTranscript === true) turn.isFullTranscript = true;
      if (item.originalSpeaker !== undefined) turn.originalSpeaker = text(item.originalSpeaker, 200);
      if (item.start !== undefined || item.end !== undefined) {
        if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start) throw new Error('Некорректные таймкоды в черновике.');
        turn.start = item.start;
        turn.end = item.end;
      }
      return turn;
    });
    if (items.reduce((n, item) => n + item.text.length, 0) > MAX_CHARACTERS) throw new Error('В расшифровке больше 2 000 000 символов.');
    return items;
  }
  function validate(value) {
    if (!value || value.type !== 'qorit-draft' || value.version !== 1) throw new Error('Это не черновик QORIT версии 1.');
    const draft = {
      type: 'qorit-draft', version: 1,
      sourceText: text(value.sourceText), sourceDirty: value.sourceDirty !== false,
      metadata: {title: text(value.metadata?.title || '', 160), meetingDate: text(value.metadata?.meetingDate || '', 10)},
      importedUtterances: value.importedUtterances == null ? null : utterances(value.importedUtterances), result: null
    };
    if (value.result != null) {
      const source = record(value.result);
      if (source.method !== undefined && !['server', 'local-rules'].includes(source.method)) throw new Error('Неизвестный метод обработки в черновике.');
      const turns = utterances(source.utterances);
      const tasks = array(source.tasks, 5000).map((task, index) => {
        record(task);
        return {
        id: taskId(task.id, index + 1), title: text(task.title, 20000), owner: text(task.owner, 2500),
        due: text(task.due || 'Не указан', 2500), dueDate: text(task.dueDate || '', 10),
        status: task.status === 'Выполнено' ? 'Выполнено' : 'В работе',
        needsReview: task.needsReview !== false, reviewed: task.reviewed === true,
        ...optionalText(task, 'originalOwner', 2500),
        ...optionalText(task, 'sourceSpeaker', 200, true),
        ...optionalText(task, 'urgency', 100),
        ...optionalText(task, 'direction', 100),
        ...optionalText(task, 'serverStatus', 100),
        source: text(task.source || ''),
        sourceIndex: Number.isInteger(task.sourceIndex) && task.sourceIndex >= 0 && task.sourceIndex < turns.length ? task.sourceIndex : null,
        assignmentBasis: text(task.assignmentBasis || '', 1000)
      }; });
      draft.result = {
        summary: text(source.summary),
        highlights: array(source.highlights || [], 1000).map(item => text(item)),
        decisions: array(source.decisions || [], 1000).map(item => text(item)),
        warnings: array(source.warnings || [], 1003).map(item => text(item)),
        utterances: turns, tasks,
        people: array(source.people, 20000).map(person => {
          array(person, 2);
          return [text(person[0], 200), text(person[1] || '', 1000)];
        }),
        method: source.method || 'local-rules',
        ...optionalText(source, 'analysisMethod', 200),
        ...optionalText(source, 'reportDate', 10, true),
        ...optionalText(source, 'reportTimezone', 100)
      };
    }
    return draft;
  }
  function parse(serialized) {
    if (typeof serialized !== 'string' || serialized.length > MAX_BYTES || new TextEncoder().encode(serialized).length > MAX_BYTES) throw new Error('Черновик должен быть не больше 20 МиБ.');
    let value;
    try { value = JSON.parse(serialized); } catch { throw new Error('Файл черновика содержит некорректный JSON.'); }
    return validate(value);
  }
  function serialize(value) {
    const serialized = JSON.stringify(validate(value));
    if (new TextEncoder().encode(serialized).length > MAX_BYTES) throw new Error('Черновик больше 20 МиБ. Сохраните протокол в DOCX.');
    return serialized;
  }
  return {parse, serialize, MAX_BYTES};
});
