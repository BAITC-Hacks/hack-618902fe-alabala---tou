const test = require('node:test');
const assert = require('node:assert/strict');
const {fromReport, processAudio, getConfig, allowedExtensions, maxTextLength} = require('../backend-api.js');

const quote = 'Айжан подготовит отчёт до 25 сентября.';
function report(overrides = {}) {
  return {
    filename: 'meeting.wav', meeting_date: '2026-09-23', as_of: '2026-09-23',
    timezone: 'Asia/Almaty', generated_at: '2026-09-23T10:00:00+00:00', analysis_method: 'local_llama:gemma-4-12b-it-Q4_K_S',
    transcript: {text: quote, segments: [{start: 65.4, end: 70.1, speaker: 'SPEAKER_00', text: quote}], speakers: ['SPEAKER_00']},
    tasks: [{id: 'task-0001', title: 'Подготовить отчёт', assignee: 'Айжан', deadline: '2026-09-25', deadline_text: 'до 25 сентября',
      status: 'in_progress', urgency: 'medium', direction: 'finance', source_quote: quote, source_speaker: 'SPEAKER_00', needs_review: false}],
    warnings: ['Статусы отражают расшифровку и дату отчета.'], dashboard: {total: 1}, ...overrides
  };
}
function json(value, status = 200) { return new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}}); }
function file(name = 'meeting.wav', content = 'synthetic-test-bytes') { return new File([content], name, {type: 'audio/wav'}); }

test('adapts real report schema without inventing a narrative summary or inferring task owners from voices', () => {
  const input = report();
  const before = structuredClone(input);
  const {result, sourceText, metadata} = fromReport(input);
  assert.deepEqual(input, before);
  assert.equal(sourceText, quote);
  assert.equal(result.method, 'server');
  assert.equal(result.analysisMethod, 'local_llama:gemma-4-12b-it-Q4_K_S');
  assert.equal(result.reportDate, '2026-09-23');
  assert.equal(result.reportTimezone, 'Asia/Almaty');
  assert.equal(metadata.meetingDate, '2026-09-23');
  assert.equal(metadata.filename, 'meeting.wav');
  assert.match(result.summary, /поручений: 1/);
  assert.match(result.summary, /саммари backend не возвращает/);
  assert.deepEqual(result.highlights, []);
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(result.utterances, [{time: '01:05', speaker: 'SPEAKER_00', text: quote, start: 65.4, end: 70.1}]);
  assert.equal(result.people[0][0], 'SPEAKER_00');
  assert.match(result.people[0][1], /сопоставьте/);
  assert.equal(result.tasks[0].owner, 'Айжан');
  assert.equal(result.tasks[0].sourceSpeaker, 'SPEAKER_00');
  assert.equal(result.tasks[0].sourceIndex, 0);
  assert.equal(result.tasks[0].dueDate, '2026-09-25');
  assert.equal(result.tasks[0].due, 'до 25 сентября');
  assert.equal(result.tasks[0].status, 'В работе');
  assert.equal(result.tasks[0].reviewed, false);
  assert.equal(result.tasks[0].needsReview, false);
  assert.ok(result.warnings.some(item => item.includes('не являются именами')));
});

test('null owner or anonymous owner always stays unconfirmed; speaker identity is not the assignee', () => {
  for (const assignee of [null, 'SPEAKER_00', 'Участник 2', 'unknown', 'я']) {
    const input = report();
    input.tasks[0].assignee = assignee;
    const task = fromReport(input).result.tasks[0];
    assert.equal(task.owner, assignee || 'Не указан');
    assert.equal(task.needsReview, true);
    assert.equal(task.reviewed, false);
  }
});

test('missing deadline is never guessed from text or urgency; server completed/overdue state is mapped', () => {
  const input = report();
  input.tasks[0].deadline = null;
  input.tasks[0].deadline_text = null;
  input.tasks[0].urgency = 'high';
  input.tasks[0].status = 'completed';
  let task = fromReport(input).result.tasks[0];
  assert.equal(task.dueDate, '');
  assert.equal(task.due, 'Не указан');
  assert.equal(task.needsReview, true);
  assert.equal(task.status, 'Выполнено');
  input.tasks[0].status = 'overdue';
  task = fromReport(input).result.tasks[0];
  assert.equal(task.status, 'В работе');
  assert.equal(task.serverStatus, 'overdue');
});

test('actual future backend summary is preserved, not rewritten by the rules analyzer', () => {
  const input = report({summary: 'Согласована доработка отчёта.', highlights: ['Нужен отчёт.'], decisions: ['Ответственная — Айжан.']});
  const result = fromReport(input).result;
  assert.equal(result.summary, input.summary);
  assert.deepEqual(result.highlights, input.highlights);
  assert.deepEqual(result.decisions, input.decisions);
});

test('incomplete segments retain full transcript exactly once and discard inaccurate voice attribution', () => {
  const input = report();
  input.transcript.text = `Вступление. ${quote} Дополнительное обсуждение.`;
  const {result, sourceText} = fromReport(input);
  assert.equal(sourceText, input.transcript.text);
  assert.deepEqual(result.utterances, [{time: '—', speaker: 'Не указан', text: input.transcript.text, isFullTranscript: true}]);
  assert.deepEqual(result.people, []);
  assert.equal(result.tasks[0].sourceIndex, null);
  assert.equal(result.tasks[0].sourceSpeaker, 'SPEAKER_00');
  assert.ok(result.warnings.some(item => item.includes('не покрывают полный текст')));
});

test('non-diarized transcript remains unassigned, and does not fabricate participants', () => {
  const input = report({transcript: {text: quote, segments: []}});
  input.tasks[0].source_speaker = null;
  const result = fromReport(input).result;
  assert.equal(result.utterances[0].speaker, 'Не указан');
  assert.deepEqual(result.people, []);
  assert.equal(result.tasks[0].sourceIndex, 0);
});

test('no-speech and no-task reports are valid and visibly warned, with no fabricated data', () => {
  const {result, sourceText} = fromReport(report({transcript: {text: '', segments: []}, tasks: []}));
  assert.equal(sourceText, '');
  assert.deepEqual(result.utterances, []);
  assert.deepEqual(result.people, []);
  assert.deepEqual(result.tasks, []);
  assert.match(result.summary, /поручений: 0/);
  assert.ok(result.warnings.some(item => item.includes('не распознал речь')));
});

test('empty full text can use valid segment text, null speaker is shown honestly and hour timings work', () => {
  const input = report({transcript: {text: '', segments: [{text: quote, speaker: null, start: 3661.3, end: 3665}]}});
  input.tasks[0].source_speaker = null;
  const {sourceText, result} = fromReport(input);
  assert.equal(sourceText, quote);
  assert.equal(result.utterances[0].speaker, 'Не указан');
  assert.equal(result.utterances[0].time, '1:01:01');
});

test('source quote spanning turns, duplicated quotes and mismatched source speakers are never guessed as one turn', () => {
  const input = report({transcript: {text: 'Айжан подготовит отчёт до 25 сентября.', segments: [
    {speaker: 'SPEAKER_00', text: 'Айжан подготовит отчёт'}, {speaker: 'SPEAKER_01', text: 'до 25 сентября.'}
  ]}});
  input.tasks[0].source_speaker = null;
  assert.equal(fromReport(input).result.tasks[0].sourceIndex, null);
  input.transcript = {text: `${quote} ${quote}`, segments: [{speaker: 'SPEAKER_00', text: quote}, {speaker: 'SPEAKER_00', text: quote}]};
  assert.equal(fromReport(input).result.tasks[0].sourceIndex, null);
  input.transcript = {text: quote, segments: [{speaker: 'SPEAKER_01', text: quote}]};
  input.tasks[0].source_speaker = 'SPEAKER_00';
  assert.equal(fromReport(input).result.tasks[0].sourceIndex, null);
});

test('malformed report fields, invalid dates/times, missing required task fields and invented quotes fail visibly', () => {
  const mutations = [
    value => { value.transcript = 'not a transcript object'; },
    value => { value.transcript.text = null; },
    value => { value.transcript.segments = {}; },
    value => { value.transcript.segments[0].speaker = {name: 'fake'}; },
    value => { value.transcript.segments[0].start = -1; },
    value => { value.transcript.segments[0].end = '70'; },
    value => { value.tasks = 'fake'; },
    value => { delete value.tasks[0].assignee; },
    value => { value.tasks[0].needs_review = 'false'; },
    value => { value.tasks[0].deadline = '2026-02-30'; },
    value => { value.tasks[0].deadline = '0000-01-01'; },
    value => { value.tasks[0].status = 'done'; },
    value => { value.tasks[0].direction = '<b>it</b>'; },
    value => { value.tasks[0].source_quote = 'Это предложение отсутствует в записи.'; },
    value => { value.tasks.push({...value.tasks[0]}); },
    value => { value.summary = {text: 'fake'}; },
    value => { value.warnings = ['valid', false]; },
    value => { value.meeting_date = 'tomorrow'; },
    value => { value.timezone = 'not-a-timezone'; }
  ];
  for (const mutate of mutations) {
    const input = report();
    mutate(input);
    assert.throws(() => fromReport(input), /Некорректный ответ backend/);
  }
});

test('excessive transcript/segment/task lengths are rejected instead of silently truncating', () => {
  assert.equal(maxTextLength, 2000000);
  assert.throws(() => fromReport(report({transcript: {text: 'а'.repeat(maxTextLength + 1)}})), /Некорректный ответ backend/);
  assert.throws(() => fromReport(report({transcript: {text: '', segments: Array(20001).fill({text: 'a'})}})), /Некорректный ответ backend/);
  assert.throws(() => fromReport(report({transcript: {text: '', segments: [{text: 'a'.repeat(maxTextLength)}, {text: 'b'}]}})), /2 000 000/);
  assert.throws(() => fromReport(report({tasks: Array(5001).fill({})})), /Некорректный ответ backend/);
});

test('untrusted transcript strings are retained as plain data, not executed or parsed as markup', () => {
  const payload = '<img src=x onerror="alert(1)"> Айжан, подготовь отчёт.';
  const input = report({transcript: {text: payload}, tasks: []});
  const {result, sourceText} = fromReport(input);
  assert.equal(sourceText, payload);
  assert.equal(result.utterances[0].text, payload);
  assert.equal(result.summary.includes(payload), false);
});

test('processAudio sends real multipart fields to same-origin endpoint exactly once with no manual content-type', async () => {
  const calls = [];
  const controller = new AbortController();
  const output = await processAudio(file('TEST.WAV'), {meetingDate: '2026-09-23', diarize: true, numSpeakers: 4}, {
    signal: controller.signal, fetchImpl: async (path, options) => {
      calls.push([path, options]);
      assert.equal(path, '/process-audio');
      assert.equal(options.method, 'POST');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.signal, controller.signal);
      assert.equal(options.headers['Content-Type'], undefined);
      assert.equal(options.body.get('audio').name, 'TEST.WAV');
      assert.equal(await options.body.get('audio').text(), 'synthetic-test-bytes');
      assert.equal(options.body.get('meeting_date'), '2026-09-23');
      assert.equal(options.body.get('diarize'), 'true');
      assert.equal(options.body.get('num_speakers'), '4');
      return json(report());
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(output.result.tasks[0].owner, 'Айжан');
});

test('optional audio parameters omitted rather than guessed; false is sent explicitly', async () => {
  await processAudio(file(), {diarize: false}, {fetchImpl: async (_, {body}) => {
    assert.equal(body.get('diarize'), 'false');
    assert.equal(body.get('meeting_date'), null);
    assert.equal(body.get('num_speakers'), null);
    return json(report());
  }});
  await processAudio(file(), {}, {fetchImpl: async (_, {body}) => {
    assert.equal(body.get('diarize'), null);
    return json(report());
  }});
});

test('invalid file/options fail before any upload and extension contract excludes unsupported video', async () => {
  let requests = 0;
  const transport = {fetchImpl: async () => { requests++; return json(report()); }};
  for (const [input, options] of [
    [file('test.wav', ''), {}], [file('test.mp4'), {}], [file('test.exe'), {}], [{name: 'test.wav', size: 1}, {}],
    [file(), {meetingDate: '2026-02-30'}], [file(), {diarize: 'true'}],
    [file(), {numSpeakers: 0}], [file(), {numSpeakers: 101}], [file(), {numSpeakers: 1.5}],
    [file(), {diarize: false, numSpeakers: 2}]
  ]) await assert.rejects(() => processAudio(input, options, transport));
  assert.equal(requests, 0);
  assert.deepEqual(allowedExtensions, ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.webm']);
});

test('config exposes only typed public limits and default, ignoring any unrelated response fields', async () => {
  const config = await getConfig({fetchImpl: async (path, options) => {
    assert.equal(path, '/api/config');
    assert.equal(options.cache, 'no-store');
    return json({max_upload_bytes: 1024, max_audio_seconds: 60.5, default_diarize: false, irrelevant: 'ignore'});
  }});
  assert.deepEqual(config, {max_upload_bytes: 1024, max_audio_seconds: 60.5, default_diarize: false});
  for (const bad of [{}, {max_upload_bytes: -1, max_audio_seconds: 1, default_diarize: true},
    {max_upload_bytes: 1024, max_audio_seconds: 1, default_diarize: 'false'}]) {
    await assert.rejects(() => getConfig({fetchImpl: async () => json(bad)}), /Некорректный ответ backend/);
  }
});

test('HTTP failures retain readable server explanations without silently falling back or retrying', async () => {
  for (const [status, expected] of [[404, /Live Server/], [413, /ограничение/], [422, /прочитать запись/], [503, /сервер занят/]]) {
    let requests = 0;
    await assert.rejects(() => processAudio(file(), {}, {fetchImpl: async () => { requests++; return json({error: 'Серверное объяснение.'}, status); }}), error => {
      assert.match(error.message, expected);
      assert.match(error.message, /Серверное объяснение/);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test('HTML, invalid JSON and JSON error payloads are not published as transcription', async () => {
  for (const response of [new Response('<html>Live Server</html>'), new Response('{"broken":'), json(['not', 'report'])]) {
    await assert.rejects(() => processAudio(file(), {}, {fetchImpl: async () => response}), /не JSON-отчёт/);
  }
  await assert.rejects(() => processAudio(file(), {}, {fetchImpl: async () => json({error: 'Модель недоступна'})}), /Модель недоступна/);
  await assert.rejects(() => processAudio(file(), {}, {fetchImpl: async () => new Response('<html>404</html>', {status: 404})}), /Маршрут backend не найден/);
});

test('network and interrupted response errors are actionable; AbortError is preserved for UI cancellation', async () => {
  await assert.rejects(() => processAudio(file(), {}, {fetchImpl: async () => { throw new TypeError('Failed to fetch'); }}), /server.py запущен/);
  await assert.rejects(() => processAudio(file(), {}, {fetchImpl: async () => ({ok: true, text: async () => { throw new Error('socket'); }})}), /Соединение прервано/);
  const abort = new DOMException('Cancelled', 'AbortError');
  await assert.rejects(() => processAudio(file(), {}, {fetchImpl: async () => { throw abort; }}), error => error === abort);
});
