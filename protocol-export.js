/* Offline exports of the current, editable protocol. No dependencies or requests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QoritExport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const encoder = new TextEncoder();
  const crcTable = Uint32Array.from({length: 256}, (_, byte) => {
    let crc = byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    return crc >>> 0;
  });

  function text(value) {
    // XML 1.0 does not allow C0 controls, lone surrogates, U+FFFE or U+FFFF.
    return Array.from(String(value == null ? '' : value)).filter(char => {
      const code = char.codePointAt(0);
      return code === 9 || code === 10 || code === 13 ||
        (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff);
    }).join('').replace(/\r\n?/g, '\n');
  }

  function escape(value) {
    return text(value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  const list = value => Array.isArray(value) ? value : [];
  const present = value => text(value).trim();
  const fallback = (value, otherwise) => present(value) || otherwise;

  function protocol(result, metadata) {
    if (!result || !list(result.utterances).some(item => item && present(item.text))) {
      throw new Error('Сначала обработайте расшифровку совещания. Пустой протокол нельзя экспортировать.');
    }
    const meta = metadata && typeof metadata === 'object' ? metadata : {};
    return {
      title: fallback(meta.title, 'Протокол совещания'),
      meetingDate: present(meta.meetingDate),
      summary: fallback(result.summary, 'Саммари не сформировано.'),
      highlights: list(result.highlights).map(text).filter(present),
      decisions: list(result.decisions).map(text).filter(present),
      warnings: list(result.warnings).map(text).filter(present),
      people: list(result.people).filter(Array.isArray).map(([name, role]) => ({
        name: fallback(name, 'Имя не указано'), role: present(role)
      })),
      tasks: list(result.tasks).filter(item => item && typeof item === 'object').map(task => ({
        id: present(task.id), title: fallback(task.title, 'Суть поручения не указана'),
        owner: fallback(task.owner, 'Не указан'), due: fallback(task.due, 'Не указан'),
        dueDate: present(task.dueDate), status: fallback(task.status, 'В работе'),
        needsReview: task.needsReview !== false, reviewed: task.reviewed === true, source: present(task.source)
      })),
      utterances: list(result.utterances).filter(item => item && present(item.text)).map(item => ({
        time: fallback(item.time, '—'), speaker: fallback(item.speaker, 'Не указан'), text: text(item.text)
      })),
      method: result.method === 'local-rules' ?
        'Расшифровка обработана локальными языковыми правилами. Это не результат ИИ-диаризации.' :
        'Проверьте расшифровку, участников, поручения и сроки перед утверждением.'
    };
  }

  function reviewLabel(task) {
    return task.needsReview ? 'требует проверки' : task.reviewed ?
      'подтверждено пользователем' : 'извлечено из текста; не подтверждено';
  }

  function paragraph(value, style = 'Normal') {
    const lines = text(value).split('\n');
    const runs = lines.map((line, index) => `${index ? '<w:r><w:br/></w:r>' : ''}` +
      `<w:r><w:t xml:space="preserve">${escape(line)}</w:t></w:r>`).join('');
    return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runs}</w:p>`;
  }

  function makeDocument(data) {
    const blocks = [paragraph(data.title, 'Title')];
    if (data.meetingDate) blocks.push(paragraph(`Дата совещания: ${data.meetingDate}`, 'Subtitle'));
    blocks.push(paragraph('ЧЕРНОВИК — требует проверки и утверждения', 'Draft'));
    blocks.push(paragraph(data.method, 'Small'));
    blocks.push(paragraph('Краткое саммари', 'Heading1'), paragraph(data.summary));
    for (const [title, items] of [['Основные факты', data.highlights], ['Решения', data.decisions]]) {
      if (!items.length) continue;
      blocks.push(paragraph(title, 'Heading1'));
      items.forEach((item, index) => blocks.push(paragraph(`${index + 1}. ${item}`)));
    }
    if (data.warnings.length) {
      blocks.push(paragraph('Замечания к обработке', 'Heading1'));
      data.warnings.forEach(item => blocks.push(paragraph(item, 'Small')));
    }
    blocks.push(paragraph('Поручения', 'Heading1'));
    if (!data.tasks.length) blocks.push(paragraph('Поручения не выделены. Проверьте расшифровку.'));
    data.tasks.forEach((task, index) => {
      blocks.push(paragraph(`${index + 1}. ${task.title}`, 'Heading2'));
      if (task.id) blocks.push(paragraph(`Идентификатор: ${task.id}`, 'Small'));
      blocks.push(paragraph(`Ответственный: ${task.owner}`));
      blocks.push(paragraph(`Срок из расшифровки: ${task.due}`));
      if (task.dueDate) blocks.push(paragraph(`Календарная дата: ${task.dueDate}`));
      blocks.push(paragraph(`Статус: ${task.status}. Проверка: ${reviewLabel(task)}.`));
      if (task.source) blocks.push(paragraph(`Исходная цитата: ${task.source}`, 'Quote'));
    });
    blocks.push(paragraph('Участники', 'Heading1'));
    if (!data.people.length) blocks.push(paragraph('Участники не определены.'));
    data.people.forEach(person => blocks.push(paragraph(`${person.name}${person.role ? ` — ${person.role}` : ''}`)));
    blocks.push(paragraph('Расшифровка', 'Heading1'));
    data.utterances.forEach(utterance => {
      blocks.push(paragraph(`${utterance.time} · ${utterance.speaker}`, 'Heading2'));
      blocks.push(paragraph(utterance.text));
    });
    return XML_HEADER + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${blocks.join('')}<w:sectPr>` +
      '<w:pgSz w:w="12240" w:h="15840"/>' +
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
      '</w:sectPr></w:body></w:document>';
  }

  function makeStyles() {
    const heading = (id, name, size) => '<w:style w:type="paragraph" w:styleId="' + id + '">' +
      `<w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
      `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="${id === 'Heading1' ? '0' : '1'}"/></w:pPr>` +
      `<w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
    return XML_HEADER + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/>' +
      '<w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="111111"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:widowControl/><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
      '<w:pPr><w:keepNext/><w:spacing w:after="180"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/></w:pPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Draft"><w:name w:val="Draft"/><w:basedOn w:val="Normal"/>' +
      '<w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Small"><w:name w:val="Small"/><w:basedOn w:val="Normal"/>' +
      '<w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/><w:color w:val="444444"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Small"/>' +
      '<w:pPr><w:ind w:left="240"/></w:pPr></w:style>' + heading('Heading1', 'heading 1', '28') +
      heading('Heading2', 'heading 2', '23') + '</w:styles>';
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
  }

  function record(length) {
    const bytes = new Uint8Array(length);
    return {bytes, view: new DataView(bytes.buffer)};
  }

  function join(parts) {
    const length = parts.reduce((total, part) => total + part.length, 0);
    if (length > 0xffffffff) throw new Error('Протокол слишком большой для экспорта DOCX.');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
  }

  function zip(entries) {
    const local = [], central = [];
    let offset = 0;
    for (const [path, content] of entries) {
      const name = encoder.encode(path), body = encoder.encode(content), crc = crc32(body);
      const header = record(30);
      header.view.setUint32(0, 0x04034b50, true);
      header.view.setUint16(4, 20, true);
      header.view.setUint16(6, 0x0800, true); // UTF-8 names, STORE (no compression).
      header.view.setUint16(12, 33, true); // 1980-01-01, stable reproducible ZIP timestamp.
      header.view.setUint32(14, crc, true);
      header.view.setUint32(18, body.length, true);
      header.view.setUint32(22, body.length, true);
      header.view.setUint16(26, name.length, true);
      local.push(header.bytes, name, body);
      const directory = record(46);
      directory.view.setUint32(0, 0x02014b50, true);
      directory.view.setUint16(4, 20, true);
      directory.view.setUint16(6, 20, true);
      directory.view.setUint16(8, 0x0800, true);
      directory.view.setUint16(14, 33, true);
      directory.view.setUint32(16, crc, true);
      directory.view.setUint32(20, body.length, true);
      directory.view.setUint32(24, body.length, true);
      directory.view.setUint16(28, name.length, true);
      directory.view.setUint32(42, offset, true);
      central.push(directory.bytes, name);
      offset += header.bytes.length + name.length + body.length;
    }
    const directoryBytes = join(central), end = record(22);
    end.view.setUint32(0, 0x06054b50, true);
    end.view.setUint16(8, entries.length, true);
    end.view.setUint16(10, entries.length, true);
    end.view.setUint32(12, directoryBytes.length, true);
    end.view.setUint32(16, offset, true);
    return join([...local, directoryBytes, end.bytes]);
  }

  function createDocx(result, metadata = {}) {
    const data = protocol(result, metadata);
    const relationsNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
    return zip([
      ['[Content_Types].xml', XML_HEADER + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '</Types>'],
      ['_rels/.rels', XML_HEADER + `<Relationships xmlns="${relationsNS}">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '</Relationships>'],
      ['word/document.xml', makeDocument(data)],
      ['word/styles.xml', makeStyles()],
      ['word/_rels/document.xml.rels', XML_HEADER + `<Relationships xmlns="${relationsNS}">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>'],
      ['docProps/core.xml', XML_HEADER + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        `<dc:title>${escape(data.title)}</dc:title><dc:description>Черновик протокола; требуется проверка и утверждение.</dc:description>` +
        '<dc:creator>QORIT</dc:creator></cp:coreProperties>']
    ]);
  }

  function createPrintHtml(result, metadata = {}) {
    const data = protocol(result, metadata);
    const p = (value, className = '') => `<p${className ? ` class="${className}"` : ''}>${escape(value)}</p>`;
    const section = (title, items) => items.length ? `<section><h2>${title}</h2><ul>${items.map(item => `<li>${escape(item)}</li>`).join('')}</ul></section>` : '';
    return '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; form-action &#39;none&#39;; base-uri &#39;none&#39;">' +
      `<title>${escape(data.title)}</title><style>` +
      '@page{size:letter;margin:1in}*{box-sizing:border-box}body{margin:32px auto;padding:0 24px;max-width:850px;color:#111;background:white;font:11pt/1.45 Arial,sans-serif}' +
      'h1{font-size:22pt;line-height:1.2;margin:0 0 14pt}h2{font-size:15pt;margin:20pt 0 8pt}h3{font-size:12pt;margin:14pt 0 6pt}' +
      'h1,h2,h3{break-after:avoid;page-break-after:avoid}p,li{white-space:pre-wrap;overflow-wrap:anywhere;orphans:3;widows:3}' +
      'p{margin:0 0 7pt}ul{padding-left:20pt}li{margin:0 0 6pt}blockquote{margin:8pt 0 12pt 12pt;padding-left:10pt;border-left:2px solid #888}' +
      '.draft{font-weight:bold}.small,.quote{font-size:10pt;color:#444}.print-action{display:block;margin:0 0 24px;padding:12px 18px;border:1px solid #222;border-radius:6px;background:#222;color:white;font:inherit;cursor:pointer}' +
      '.task{border-bottom:1px solid #ccc;padding-bottom:8pt}.speaker{font-size:11pt}button:focus-visible{outline:3px solid #666;outline-offset:3px}' +
      '@media print{body{margin:0;padding:0;max-width:none}.print-action{display:none}}' +
      '</style></head><body><button id="print-protocol" type="button" class="print-action">Печать / сохранить PDF</button>' +
      `<main><h1>${escape(data.title)}</h1>${data.meetingDate ? p(`Дата совещания: ${data.meetingDate}`) : ''}` +
      p('ЧЕРНОВИК — требует проверки и утверждения', 'draft') + p(data.method, 'small') +
      `<section><h2>Краткое саммари</h2>${p(data.summary)}</section>` +
      section('Основные факты', data.highlights) + section('Решения', data.decisions) + section('Замечания к обработке', data.warnings) +
      '<section><h2>Поручения</h2>' + (data.tasks.length ? data.tasks.map((task, index) =>
        `<article class="task"><h3>${index + 1}. ${escape(task.title)}</h3>` +
        (task.id ? p(`Идентификатор: ${task.id}`, 'small') : '') + p(`Ответственный: ${task.owner}`) +
        p(`Срок из расшифровки: ${task.due}`) + (task.dueDate ? p(`Календарная дата: ${task.dueDate}`) : '') +
        p(`Статус: ${task.status}. Проверка: ${reviewLabel(task)}.`) +
        (task.source ? `<blockquote>${p(`Исходная цитата: ${task.source}`, 'quote')}</blockquote>` : '') + '</article>'
      ).join('') : p('Поручения не выделены. Проверьте расшифровку.')) + '</section>' +
      `<section><h2>Участники</h2>${data.people.length ? data.people.map(person => p(`${person.name}${person.role ? ` — ${person.role}` : ''}`)).join('') : p('Участники не определены.')}</section>` +
      '<section><h2>Расшифровка</h2>' + data.utterances.map(item =>
        `<article><h3 class="speaker">${escape(item.time)} · ${escape(item.speaker)}</h3>${p(item.text)}</article>`
      ).join('') + '</section></main></body></html>';
  }

  return {createDocx, createPrintHtml};
}));
