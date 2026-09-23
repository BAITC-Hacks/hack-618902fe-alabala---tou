const test = require('node:test');
const assert = require('node:assert/strict');
const {parseImport, isUnassigned, dateState, summarizeTasks, renameSpeaker, localToday} = require('../meeting-utils.js');
const {analyzeTranscript} = require('../transcript-analyzer.js');

test('TXT imports preserve text, normalize line endings and never invent timestamps', () => {
  assert.deepEqual(parseImport('\uFEFFАнна: Привет.\r\nАйжан: Сәлем.\r', 'meeting.TXT'), {
    sourceText: 'Анна: Привет.\nАйжан: Сәлем.', utterances: null, timestampsApproximate: false
  });
  assert.equal(parseImport('Иван: Отправлю отчёт завтра.').utterances, null);
  assert.throws(() => parseImport(' ', 'meeting.txt'), /пуст/);
  assert.throws(() => parseImport(null, 'meeting.txt'), /UTF-8/);
  assert.throws(() => parseImport('meeting', 'audio.mp3'), /\.txt/);
});

test('STT JSON preserves speaker IDs, null attribution, order, overlaps and actual times', () => {
  const data = {text: 'Подготовлю отчёт завтра. Есепті жіберемін.', duration: 3700,
    timestamps_approximate: true, speakers: ['SPEAKER_00'], segments: [
      {start: 65.25, end: 68.5, speaker: 'SPEAKER_00', text: 'Подготовлю отчёт завтра.'},
      {start: 67, end: 70, speaker: null, text: 'Есепті жіберемін.'},
      {start: 3661, end: 3665, speaker: 'SPEAKER_00', text: 'Хорошо.'}
    ]};
  const result = parseImport(JSON.stringify(data), 'result.json');
  assert.equal(result.timestampsApproximate, true);
  assert.deepEqual(result.utterances[0], {start: 65.25, end: 68.5, speaker: 'SPEAKER_00', text: 'Подготовлю отчёт завтра.', time: '01:05'});
  assert.equal(result.utterances[1].speaker, 'Не указан');
  assert.equal(result.utterances[1].start, 67);
  assert.equal(result.utterances[2].time, '01:01:01');
  assert.equal(result.sourceText, '[01:05] SPEAKER_00: Подготовлю отчёт завтра.\n[01:07] Не указан: Есепті жіберемін.\n[01:01:01] SPEAKER_00: Хорошо.');
});

test('plain JSON text fallback accepts only the documented text schema', () => {
  assert.equal(parseImport('{"text":"Есепті жіберемін."}', 'r.json').sourceText, 'Есепті жіберемін.');
  assert.equal(parseImport('{"text":"Отчёт.","timestamps_approximate":"true"}', 'r.json').timestampsApproximate, false);
  for (const input of ['null', '[]', '12', 'false', '{}', '{"result":"pretend transcript"}', '{"text":12}', '{"text":""}']) {
    assert.throws(() => parseImport(input, 'r.json'), undefined, input);
  }
  assert.throws(() => parseImport('{', 'r.json'), /Некорректный JSON/);
});

test('fake backend processing confirmations are rejected in all supported import shapes', () => {
  const confirmation = 'Аудиофайл meeting.webm успешно обработан';
  assert.throws(() => parseImport(confirmation, 'r.txt'), /не расшифровку/);
  assert.throws(() => parseImport(JSON.stringify({text: confirmation}), 'r.json'), /не расшифровку/);
  assert.throws(() => parseImport(JSON.stringify({segments: [{start: 0, end: 1, speaker: null, text: confirmation}]}), 'r.json'), /не расшифровку/);
});

test('invalid segments fail visibly instead of being filtered, truncated or silently coerced', () => {
  const good = {start: 0, end: 2, speaker: 'SPEAKER_00', text: 'Сәлем.'};
  const invalid = [null, [], {}, {...good, start: -1}, {...good, start: '0'}, {...good, end: -1},
    {...good, end: null}, {...good, text: ''}, {...good, text: 100}, {...good, speaker: 1}, {...good, speaker: 'first\nsecond'}, {...good, speaker: 'x'.repeat(81)}];
  for (const segment of invalid) assert.throws(() => parseImport(JSON.stringify({segments: [good, segment]}), 'r.json'));
  for (const segments of [[], null, {}, 'text']) assert.throws(() => parseImport(JSON.stringify({text: 'fallback', segments}), 'r.json'), /segments/);
  assert.throws(() => parseImport(JSON.stringify({duration: 1, segments: [good]}), 'r.json'), /длительности/);
  assert.throws(() => parseImport(JSON.stringify({duration: -1, text: 'Report'}), 'r.json'), /duration/);
  assert.throws(() => parseImport('{"segments":[{"start":0,"end":1e309,"text":"word"}]}', 'r.json'), /start\/end/);
});

test('import text and segment count limits are enforced without losing the tail', () => {
  assert.equal(parseImport('x'.repeat(200000), 'r.txt').sourceText.length, 200000);
  assert.throws(() => parseImport('x'.repeat(200001), 'r.txt'), /200000/);
  assert.throws(() => parseImport(JSON.stringify({text: 'x'.repeat(200001)}), 'r.json'), /200000/);
  assert.throws(() => parseImport(JSON.stringify({segments: Array.from({length: 5001}, () => ({start: 0, end: 1, text: 'x'}))}), 'r.json'), /5000/);
  assert.throws(() => parseImport(JSON.stringify({segments: [
    {start: 0, end: 1, text: 'x'.repeat(110000)}, {start: 1, end: 2, text: 'x'.repeat(110000)}
  ]}), 'r.json'), /200000/);
});

test('anonymous diarization IDs and generic labels are never treated as known people', () => {
  for (const name of [null, undefined, '', ' ', 'Не указан', 'не определён', 'SPEAKER_00', 'speaker-1', 'SPEAKER 01', 'Участник 12', 'Говорящий 2', 'Спикер', 'Неизвестный участник', 'Unknown', 'null', '—']) {
    assert.equal(isUnassigned(name), true, String(name));
  }
  for (const name of ['Айжан', 'Иван Петров', 'Данияр Серикович', 'Ерлан', 'Speaker Jones']) assert.equal(isUnassigned(name), false, name);
});

test('date state uses only an explicit valid calendar date, not relative transcript wording', () => {
  const today = '2026-09-23';
  assert.equal(dateState({due: 'вчера'}, today), 'undated');
  assert.equal(dateState({due: 'до 01.09.2026'}, today), 'undated');
  assert.equal(dateState({dueDate: '2026-09-22'}, today), 'overdue');
  assert.equal(dateState({dueDate: today}, today), 'upcoming');
  assert.equal(dateState({dueDate: '2026-09-26'}, today), 'upcoming');
  assert.equal(dateState({dueDate: '2026-09-27'}, today), 'working');
  assert.equal(dateState({dueDate: '2026-09-24'}, today, 0), 'working');
  assert.equal(dateState({dueDate: '2020-01-01', status: 'Выполнено'}, today), 'done');
  assert.equal(dateState({status: 'done'}, today), 'done');
  for (const dueDate of ['', 'tomorrow', '2026-02-29', '2026-13-01', '2026-09-31', '2026-9-23', '0000-01-01', '2026-09-23T00:00:00Z']) assert.equal(dateState({dueDate}, today), 'undated');
  assert.equal(dateState({dueDate: '2028-02-29'}, '2028-02-28'), 'upcoming');
  assert.equal(dateState({dueDate: '2027-01-01'}, '2026-12-31'), 'upcoming');
  assert.throws(() => dateState({dueDate: today}, 'bad'), /текущая дата/);
  assert.throws(() => dateState({dueDate: today}, today, -1), /неотрицательным/);
  assert.match(localToday(), /^\d{4}-\d{2}-\d{2}$/);
});

test('dashboard counts partition every task exactly once', () => {
  const result = summarizeTasks([
    {dueDate: '2026-09-23'}, {dueDate: '2026-09-24'}, {dueDate: '2026-09-01'},
    {dueDate: '2026-09-30'}, {due: 'пятница'}, {dueDate: '2020-01-01', status: 'Выполнено'}
  ], '2026-09-23');
  assert.deepEqual(result, {total: 6, working: 1, upcoming: 2, overdue: 1, done: 1, undated: 1});
});

test('manual speaker mapping changes exact identities only and preserves evidence immutably', () => {
  const result = analyzeTranscript([
    {speaker: 'SPEAKER_00', time: '00:01', text: 'Подготовлю отчёт завтра.'},
    {speaker: 'SPEAKER_01', time: '00:03', text: 'Отправлю презентацию сегодня.'}
  ]);
  const before = structuredClone(result);
  const renamed = renameSpeaker(result, 'SPEAKER_00', '  Айжан  Нурлановна ');
  assert.deepEqual(result, before);
  assert.equal(renamed.people[0][0], 'Айжан Нурлановна');
  assert.equal(renamed.people[1][0], 'SPEAKER_01');
  assert.equal(renamed.utterances[0].originalSpeaker, 'SPEAKER_00');
  assert.equal(renamed.tasks[0].owner, 'Айжан Нурлановна');
  assert.equal(renamed.tasks[0].originalOwner, 'SPEAKER_00');
  assert.equal(renamed.tasks[0].needsReview, true);
  assert.equal(renamed.tasks[0].reviewed, false);
  assert.equal(renamed.tasks[0].source, before.tasks[0].source);
  assert.equal(renamed.tasks[0].assignmentBasis, before.tasks[0].assignmentBasis);
  assert.deepEqual(renamed.tasks[1], result.tasks[1]);
  const secondRename = renameSpeaker(renamed, 'Айжан Нурлановна', 'Айжан Нурланова');
  assert.equal(secondRename.utterances[0].originalSpeaker, 'SPEAKER_00');
  assert.equal(secondRename.tasks[0].originalOwner, 'SPEAKER_00');
});

test('mapping rejects unknown labels, blank/generic/multiline names and existing participants', () => {
  const result = analyzeTranscript([{speaker: 'SPEAKER_00', text: 'Подготовлю отчёт завтра.'}, {speaker: 'Иван', text: 'Спасибо.'}]);
  for (const name of ['', ' ', 'SPEAKER_01', 'Не указан', 'Участник 1', 'Айжан\nНурлановна', 'x'.repeat(81), 'Иван', '  ИВАН  ']) {
    assert.throws(() => renameSpeaker(result, 'SPEAKER_00', name), undefined, name);
  }
  assert.throws(() => renameSpeaker(result, 'missing', 'Айжан'), /не найден/);
  assert.throws(() => renameSpeaker(null, 'SPEAKER_00', 'Айжан'), /протокол/);
});
