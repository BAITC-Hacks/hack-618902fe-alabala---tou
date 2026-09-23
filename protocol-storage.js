/* Versioned, strictly validated browser drafts. No audio or credentials. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QoritStorage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_BYTES = 5 * 1024 * 1024;
  function text(value, max = 200000) {
    if (typeof value !== 'string' || value.length > max) throw new Error('Некорректный или слишком длинный текст в черновике.');
    return value;
  }
  function array(value, max) {
    if (!Array.isArray(value) || value.length > max) throw new Error('Некорректный список в черновике.');
    return value;
  }
  function utterances(value) {
    const items = array(value, 5000).map(item => {
      const turn = {time: text(item.time || '—', 30), speaker: text(item.speaker, 160), text: text(item.text)};
      if (item.originalSpeaker !== undefined) turn.originalSpeaker = text(item.originalSpeaker, 160);
      if (item.start !== undefined || item.end !== undefined) {
        if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start) throw new Error('Некорректные таймкоды в черновике.');
        turn.start = item.start;
        turn.end = item.end;
      }
      return turn;
    });
    if (items.reduce((n, item) => n + item.text.length, 0) > 200000) throw new Error('В расшифровке больше 200 000 символов.');
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
      const source = value.result;
      const turns = utterances(source.utterances);
      const tasks = array(source.tasks, 2000).map((task, index) => ({
        id: index + 1, title: text(task.title, 20000), owner: text(task.owner, 160),
        due: text(task.due || 'Не указан', 1000), dueDate: text(task.dueDate || '', 10),
        status: task.status === 'Выполнено' ? 'Выполнено' : 'В работе',
        needsReview: task.needsReview !== false, reviewed: task.reviewed === true,
        ...(task.originalOwner !== undefined ? {originalOwner: text(task.originalOwner, 160)} : {}),
        source: text(task.source || '', 200000),
        sourceIndex: Number.isInteger(task.sourceIndex) && task.sourceIndex >= 0 && task.sourceIndex < turns.length ? task.sourceIndex : null,
        assignmentBasis: text(task.assignmentBasis || '', 1000)
      }));
      draft.result = {
        summary: text(source.summary),
        highlights: array(source.highlights || [], 100).map(item => text(item)),
        decisions: array(source.decisions || [], 100).map(item => text(item)),
        warnings: array(source.warnings || [], 100).map(item => text(item)),
        utterances: turns, tasks,
        people: array(source.people, 5000).map(person => [text(person[0], 160), text(person[1] || '', 1000)]),
        method: 'local-rules'
      };
    }
    return draft;
  }
  function parse(serialized) {
    if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).length > MAX_BYTES) throw new Error('Черновик должен быть не больше 5 МБ.');
    let value;
    try { value = JSON.parse(serialized); } catch { throw new Error('Файл черновика содержит некорректный JSON.'); }
    return validate(value);
  }
  function serialize(value) {
    const serialized = JSON.stringify(validate(value));
    if (new TextEncoder().encode(serialized).length > MAX_BYTES) throw new Error('Черновик больше 5 МБ. Сохраните протокол в DOCX.');
    return serialized;
  }
  return {parse, serialize, MAX_BYTES};
});
