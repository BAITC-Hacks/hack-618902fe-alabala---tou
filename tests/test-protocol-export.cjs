const test = require('node:test');
const assert = require('node:assert/strict');
const {createDocx, createPrintHtml} = require('../protocol-export.js');

function fixture() {
  return {
    method: 'local-rules', summary: 'Өндіріс көрсеткіштері: выпуск — 94%.',
    highlights: ['Поставка сырья задержана на 5 дней.'], decisions: ['Искать второго поставщика.'],
    warnings: ['Срок второго поручения требует уточнения.'],
    people: [['Әлия Қайратқызы', 'Руководитель'], ['Ерлан', 'Юрист']],
    utterances: [{time: '00:14', speaker: 'Әлия Қайратқызы', text: 'Ерлан, подготовь претензию до пятницы.\nЕсепті жұмаға дейін дайындаңыз.'}],
    tasks: [{id: 'task-1', title: 'Подготовить претензию', owner: 'Ерлан', due: 'до пятницы',
      dueDate: '2026-09-25', status: 'В работе', needsReview: true,
      source: 'Ерлан, подготовь претензию до пятницы.'}]
  };
}

// Independent STORE ZIP reader, including local records, central directory and CRC.
function unzip(bytes) {
  const data = Buffer.from(bytes), files = new Map(), records = new Map();
  const end = data.length - 22;
  assert.equal(data.readUInt32LE(end), 0x06054b50);
  assert.equal(data.readUInt16LE(end + 4), 0);
  assert.equal(data.readUInt16LE(end + 6), 0);
  assert.equal(data.readUInt16LE(end + 20), 0);
  const count = data.readUInt16LE(end + 10), start = data.readUInt32LE(end + 16);
  assert.equal(data.readUInt16LE(end + 8), count);
  assert.equal(start + data.readUInt32LE(end + 12), end);
  let position = 0;
  while (position < start) {
    const localOffset = position;
    assert.equal(data.readUInt32LE(position), 0x04034b50);
    assert.equal(data.readUInt16LE(position + 6), 0x0800);
    assert.equal(data.readUInt16LE(position + 8), 0);
    const crc = data.readUInt32LE(position + 14), size = data.readUInt32LE(position + 18);
    assert.equal(data.readUInt32LE(position + 22), size);
    const nameLength = data.readUInt16LE(position + 26), extraLength = data.readUInt16LE(position + 28);
    const name = data.toString('utf8', position + 30, position + 30 + nameLength);
    position += 30 + nameLength + extraLength;
    const body = data.subarray(position, position + size);
    let checksum = 0xffffffff;
    for (const byte of body) {
      checksum ^= byte;
      for (let i = 0; i < 8; i++) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
    }
    assert.equal((checksum ^ 0xffffffff) >>> 0, crc, name);
    assert.ok(!files.has(name));
    files.set(name, body.toString('utf8'));
    records.set(name, {crc, size, localOffset});
    position += size;
  }
  assert.equal(position, start);
  assert.equal(files.size, count);
  for (let index = 0; index < count; index++) {
    assert.equal(data.readUInt32LE(position), 0x02014b50);
    assert.equal(data.readUInt16LE(position + 8), 0x0800);
    assert.equal(data.readUInt16LE(position + 10), 0);
    const nameLength = data.readUInt16LE(position + 28);
    const name = data.toString('utf8', position + 46, position + 46 + nameLength);
    const record = records.get(name);
    assert.ok(record, name);
    assert.equal(data.readUInt32LE(position + 16), record.crc);
    assert.equal(data.readUInt32LE(position + 20), record.size);
    assert.equal(data.readUInt32LE(position + 24), record.size);
    assert.equal(data.readUInt32LE(position + 42), record.localOffset);
    position += 46 + nameLength + data.readUInt16LE(position + 30) + data.readUInt16LE(position + 32);
  }
  assert.equal(position, end);
  return files;
}

test('DOCX is a consistent real ZIP with OOXML relationships and styles', () => {
  const bytes = createDocx(fixture(), {title: 'Рабочее совещание', meetingDate: '2026-09-23'});
  assert.ok(bytes instanceof Uint8Array);
  const files = unzip(bytes);
  assert.deepEqual([...files.keys()].sort(), ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml',
    'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml'].sort());
  assert.match(files.get('[Content_Types].xml'), /wordprocessingml\.document\.main\+xml/);
  assert.match(files.get('_rels/.rels'), /Target="word\/document\.xml"/);
  assert.match(files.get('word/_rels/document.xml.rels'), /Target="styles\.xml"/);
  assert.match(files.get('word/styles.xml'), /w:styleId="Title"/);
  assert.match(files.get('word/styles.xml'), /<w:keepNext\/>/);
  assert.match(files.get('word/styles.xml'), /w:sz w:val="22"/);
  assert.match(files.get('word/document.xml'), /w:pgSz w:w="12240" w:h="15840"/);
  assert.match(files.get('word/document.xml'), /Дата совещания: 2026-09-23/);
});

test('both formats include all current protocol sections, Unicode, evidence and review state', () => {
  const result = fixture();
  const xml = unzip(createDocx(result)).get('word/document.xml'), html = createPrintHtml(result);
  for (const output of [xml, html]) {
    for (const expected of ['Өндіріс көрсеткіштері', 'Әлия Қайратқызы', 'Есепті жұмаға дейін дайындаңыз.',
      'Поставка сырья задержана', 'Искать второго поставщика.', 'Срок второго поручения',
      'Идентификатор: task-1', 'Ответственный: Ерлан', 'Календарная дата: 2026-09-25',
      'Статус: В работе', 'требует проверки', 'Исходная цитата:', 'ЧЕРНОВИК',
      'Расшифровка', 'Участники', 'Это не результат ИИ-диаризации.']) {
      assert.ok(output.includes(expected), expected);
    }
  }
  assert.match(xml, /<w:br\/>/);
});

test('edits are exported immediately without mutating or caching the result', () => {
  const result = fixture(), before = structuredClone(result);
  const original = createDocx(result);
  assert.deepEqual(result, before);
  assert.deepEqual(original, createDocx(result));
  result.tasks[0].owner = 'Айжан';
  result.tasks[0].due = 'Срок уточнён';
  result.tasks[0].dueDate = '2026-10-01';
  result.tasks[0].status = 'Выполнено';
  result.tasks[0].needsReview = false;
  result.tasks[0].reviewed = true;
  result.summary = 'Изменённое саммари.';
  for (const output of [unzip(createDocx(result)).get('word/document.xml'), createPrintHtml(result)]) {
    assert.ok(output.includes('Ответственный: Айжан'));
    assert.ok(output.includes('Календарная дата: 2026-10-01'));
    assert.ok(output.includes('Статус: Выполнено'));
    assert.ok(output.includes('подтверждено пользователем'));
    assert.ok(output.includes('Изменённое саммари.'));
    assert.ok(!output.includes('Ответственный: Ерлан'));
  }
  assert.notDeepEqual(original, createDocx(result));
});

test('confident extraction is not presented as manual confirmation', () => {
  const result = fixture();
  result.tasks[0].needsReview = false;
  for (const output of [unzip(createDocx(result)).get('word/document.xml'), createPrintHtml(result)]) {
    assert.ok(output.includes('извлечено из текста; не подтверждено'));
    assert.ok(!output.includes('подтверждено пользователем'));
  }
});

test('user content cannot inject HTML, XML, scripts, external resources or attributes', () => {
  const attack = '</p><script>alert("x")</script><img src="https://invalid.example" onerror="x"> & \'x\'';
  const result = fixture();
  result.summary = attack;
  result.highlights = [attack]; result.decisions = [attack]; result.warnings = [attack];
  result.people = [[attack, attack]];
  result.utterances = [{time: attack, speaker: attack, text: attack}];
  result.tasks = [{id: attack, title: attack, owner: attack, due: attack, dueDate: attack, status: attack, source: attack}];
  for (const output of [unzip(createDocx(result, {title: attack, meetingDate: attack})).get('word/document.xml'),
    createPrintHtml(result, {title: attack, meetingDate: attack})]) {
    assert.ok(!output.includes('<script>'));
    assert.ok(!output.includes('<img '));
    assert.ok(output.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
    assert.ok(output.includes('&amp; &#39;x&#39;'));
  }
  const html = createPrintHtml(result);
  assert.ok(!/<(?:script|link|iframe|img)\b/i.test(html));
  assert.ok(!/<[^>]*\son(?:click|load|error)\s*=/i.test(html));
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /id="print-protocol"/);
  assert.match(html, /@media print/);
});

test('XML-invalid controls and lone surrogates are removed without losing Kazakh letters or emoji', () => {
  const result = fixture();
  result.utterances[0].text = 'ӘҒҚҢӨҰҮҺІ\u0000\u0001\u000b\u000c\u001f\ufffe\uffff\ud800\u0000\udfff 😀\tЖ\nЖ';
  for (const output of [unzip(createDocx(result)).get('word/document.xml'), createPrintHtml(result)]) {
    assert.ok(output.includes('ӘҒҚҢӨҰҮҺІ 😀\tЖ'));
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(output));
    assert.ok(!output.includes('\ufffd'));
  }
});

test('missing or blank source prevents exporting fake or empty protocol', () => {
  for (const invalid of [null, {}, {utterances: []}, {utterances: [{text: '  '}]}, {summary: 'Only a summary'}]) {
    assert.throws(() => createDocx(invalid), /Сначала обработайте расшифровку/);
    assert.throws(() => createPrintHtml(invalid), /Сначала обработайте расшифровку/);
  }
});

test('source-only protocol is honest about missing tasks and participants', () => {
  const result = {utterances: [{text: 'Встреча завершена.'}]};
  for (const output of [unzip(createDocx(result)).get('word/document.xml'), createPrintHtml(result)]) {
    assert.ok(output.includes('Саммари не сформировано.'));
    assert.ok(output.includes('Поручения не выделены.'));
    assert.ok(output.includes('Участники не определены.'));
    assert.ok(output.includes('Встреча завершена.'));
    assert.ok(!output.includes('Самрук'));
  }
});

test('server reports retain analysis origin, classification, evidence and original voice IDs in both exports', () => {
  const result = fixture();
  Object.assign(result, {method: 'server', analysisMethod: 'local_llama:gemma-4-12b-it-Q4_K_S', reportDate: '2026-09-23', reportTimezone: 'Asia/Almaty', summary: ''});
  Object.assign(result.tasks[0], {urgency: 'high', direction: 'legal', serverStatus: 'overdue', status: 'Выполнено', sourceSpeaker: 'SPEAKER_00', originalOwner: 'SPEAKER_01'});
  result.utterances[0].originalSpeaker = 'SPEAKER_00';
  const before = structuredClone(result);
  for (const output of [unzip(createDocx(result)).get('word/document.xml'), createPrintHtml(result)]) {
    for (const expected of ['Источник анализа: сервер.', 'local_llama:gemma-4-12b-it-Q4_K_S', 'Исходный отчёт: 2026-09-23',
      'Asia/Almaty', 'Сводка ответа сервера', 'Развёрнутое саммари не получено от backend.',
      'Срочность по оценке сервера: Высокая', 'Направление: Юридическое', 'Статус: Выполнено',
      'Статус при серверной обработке: Просрочено (до ручных правок)',
      'Говорящий в исходной цитате: SPEAKER_00. Это не обязательно ответственный.',
      'исходная метка: SPEAKER_00', 'Исходное обозначение ответственного: SPEAKER_01']) assert.ok(output.includes(expected), expected);
    assert.ok(!output.includes('обработана локальными языковыми правилами'));
  }
  assert.deepEqual(result, before);
});

test('server metadata remains escaped text, never executable markup', () => {
  const result = fixture(), attack = '<script>alert("origin")</script>';
  Object.assign(result, {method: 'server', analysisMethod: attack, reportDate: attack, reportTimezone: attack});
  Object.assign(result.tasks[0], {sourceSpeaker: attack, originalOwner: attack});
  result.utterances[0].originalSpeaker = attack;
  for (const output of [unzip(createDocx(result)).get('word/document.xml'), createPrintHtml(result)]) {
    assert.ok(output.includes('&lt;script&gt;alert(&quot;origin&quot;)&lt;/script&gt;'));
    assert.ok(!output.includes('<script>'));
  }
});
