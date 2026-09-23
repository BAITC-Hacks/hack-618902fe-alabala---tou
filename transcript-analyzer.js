/* Local, deterministic analysis. No network calls or audio/speaker recognition. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QoritAnalyzer = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const UPPER = 'А-ЯЁӘҒҚҢӨҰҮҺІA-Z';
  const LOWER = 'а-яёәғқңөұүһіa-z';
  const WORD = `[${UPPER}][${LOWER}]+`;
  const PATRONYMIC = `[${UPPER}][${LOWER}]+(?:ович|евич|овна|евна|ұлы|қызы)`;
  const FULL_NAME = `${WORD}\\s+${PATRONYMIC}`;
  const UNKNOWN = 'Не указан';
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
  const escapeRE = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lower = value => value.toLocaleLowerCase('ru').replace(/ё/g, 'е');
  const shorten = (text, limit) => text.length <= limit ? text : text.slice(0, limit).replace(/\s+\S*$/, '') + '…';
  const isUnknown = name => !name || /^(?:не указан|неизвест|участник\s*\d*|speaker\s*\d*)$/i.test(name);
  const HEADER = /^(?:тема|дата|время|повестка|протокол|текст совещания|саммари|итоги|поручения|ответственный|срок|решение|summary|transcript)$/i;

  function sentenceParts(text) {
    return compact(text).replace(/(\d)\.(?=\d)/g, '$1\uE000')
      .replace(/\b(доп|т\.д|т\.п)\./gi, '$1\uE000')
      .split(/(?<=[.!?])\s+/u)
      .map(value => value.replace(/\uE000/g, '.').trim()).filter(Boolean);
  }

  function cleanInput(input, warnings) {
    const text = String(input || '').replace(/\r\n?/g, '\n').trim();
    const heading = /(?:^|\s)(?:Саммари по ключевым пунктам|Краткое саммари совещания|Поручения\s+Поручение\s+Ответственный\s+Срок)(?:\s|:|$)/iu.exec(text);
    if (!heading) return text;
    warnings.push('Готовое саммари или таблица поручений после расшифровки исключены из повторного анализа.');
    return text.slice(0, heading.index).trim();
  }

  function parseTranscript(input, warnings) {
    const people = new Map();
    if (Array.isArray(input)) {
      const utterances = input.filter(item => item && compact(item.text)).map(item => {
        const speaker = compact(item.speaker) || UNKNOWN;
        if (!isUnknown(speaker)) people.set(speaker, compact(item.role) || 'Указан в расшифровке');
        return {time: compact(item.time) || '—', speaker, text: compact(item.text)};
      });
      return {utterances, people};
    }
    const text = cleanInput(input, warnings);
    if (!text) return {utterances: [], people};
    const names = new Set();
    const roles = new Map();
    // Patronymics distinguish participant labels from capitalized sentence starts.
    for (const match of text.matchAll(new RegExp(FULL_NAME, 'gu'))) names.add(compact(match[0]));
    const namedRole = new RegExp(`(${FULL_NAME}|${WORD}(?:\\s+${WORD}){0,2})\\s*\\(([^)\\n]{3,150})\\)`, 'gu');
    for (const match of text.matchAll(namedRole)) {
      const name = compact(match[1]);
      if (HEADER.test(name)) continue;
      names.add(name);
      roles.set(name, compact(match[2]));
    }
    const lineLabel = new RegExp(`^\\s*(?:\\[?(\\d{1,2}:\\d{2}(?::\\d{2})?)\\]?\\s+)?(${WORD}(?:\\s+${WORD}){0,2}|Участник\\s+\\d+|SPEAKER_\\d+)\\s*[:：]\\s*`, 'gmu');
    for (const match of text.matchAll(lineLabel)) if (!HEADER.test(match[2])) names.add(compact(match[2]));

    if (!names.size) {
      warnings.push('В тексте нет явных меток говорящих. Имена участников нельзя восстановить по голосу из текста.');
      return {utterances: text.split(/\n\s*\n/).map(part => ({time: '—', speaker: UNKNOWN, text: compact(part)})), people};
    }
    const labels = [];
    const pattern = new RegExp(`(${[...names].sort((a, b) => b.length - a.length).map(name => escapeRE(name).replace(/ /g, '\\s+')).join('|')})(?![${LOWER}${UPPER}])`, 'gu');
    const closingSummary = text.search(/Подытожим\s*[—:]/u);
    for (const match of text.matchAll(pattern)) {
      const at = match.index;
      if (at && new RegExp(`[${LOWER}${UPPER}]`, 'u').test(text[at - 1])) continue;
      const precedingLine = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
      const atLineStart = /^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*)?$/.test(precedingLine);
      if (closingSummary >= 0 && at > closingSummary && !atLineStart) continue;
      let end = at + match[0].length;
      let tail = text.slice(end);
      if (/^\s*,/.test(tail)) continue; // Vocative: «Жандос Талгатович, ...».
      const role = /^\s*\(([^)\n]{3,150})\)/.exec(tail);
      if (role) { end += role[0].length; tail = text.slice(end); }
      const punctuation = /^\s*[:：—–]\s*/.exec(tail);
      const uppercaseSpeech = new RegExp(`^\\s+[${UPPER}]`, 'u').test(tail);
      if (!atLineStart && !role && !punctuation && !uppercaseSpeech) continue;
      // Mentions such as «передайте Данияру ...» are not speaker labels.
      if (!atLineStart && /(?:^|\s)(?:для|от|к|у|с|через|пусть|поручаю|прошу)\s+$/iu.test(text.slice(Math.max(0, at - 20), at))) continue;
      if (punctuation) end += punctuation[0].length;
      const time = /(\d{1,2}:\d{2}(?::\d{2})?)/.exec(precedingLine)?.[1] || '—';
      const name = compact(match[0]);
      labels.push({at: atLineStart ? at - precedingLine.length : at, end, name, time});
      people.set(name, roles.get(name) || (role && compact(role[1])) || 'Указан в расшифровке');
    }
    if (!labels.length) {
      warnings.push('Имена встречаются в тексте, но явные границы реплик не найдены.');
      return {utterances: [{time: '—', speaker: UNKNOWN, text: compact(text)}], people: new Map()};
    }
    const utterances = labels.map((label, index) => ({
      time: label.time, speaker: label.name,
      text: compact(text.slice(label.end, labels[index + 1]?.at ?? text.length)).replace(/^[:：—–]\s*/, '')
    })).filter(item => item.text);
    const preamble = compact(text.slice(0, labels[0].at));
    if (preamble && !/протокол|текст совещания|тема|повестка/iu.test(preamble)) {
      utterances.unshift({time: '—', speaker: UNKNOWN, text: preamble});
    }
    return {utterances, people};
  }

  const ACTION_WORDS = [
    'подготов(?:ь|ьте|ит|лю|им)', 'собер(?:и|ите|ёт|ет|у|ём|ем)',
    'организ(?:уй|уйте|ует|ую|уем)', 'провер(?:ь|ьте|ит|ю|им)',
    'отправ(?:ь|ьте|ит|лю|им)', 'направ(?:ь|ьте|ит|лю|им)',
    'соглас(?:уй|уйте|ует|ую|уем)', 'най(?:ди|дите|дёт|дет|ду|дём|дем)',
    'ищи(?:те)?', 'зафиксир(?:уй|уйте|ует|ую|уем)',
    'заверш(?:и|ите|ит|у|им)', 'закро(?:й|йте|ет|ю|ем)',
    'обнов(?:и|ите|ит|лю|им)', 'пропиш(?:и|ите|ет|у|ем)',
    'привлек(?:и|ите|у|ут)', 'привлеч(?:ёт|ет|ём|ем)',
    'сдела(?:й|йте|ет|ю|ем)', 'пришл(?:и|ите|ёт|ет|ю|ём|ем)',
    'предостав(?:ь|ьте|ит|лю|им)', 'представ(?:ь|ьте|ит|лю|им)',
    'разработа(?:й|йте|ет|ю|ем)', 'утверд(?:и|ите|ит|ю|им)',
    'переда(?:й|йте|ст|м|дим)', 'провед(?:и|ите|ёт|ет|у|ём|ем)',
    'внедр(?:и|ите|ит|ю|им)', 'уточн(?:и|ите|ит|ю|им)',
    'состав(?:ь|ьте|ит|лю|им)', 'исправ(?:ь|ьте|ит|лю|им)',
    'дам', 'дадим',
    'дайында(?:ңыз|сын|ймын|ймыз)', 'жібер(?:іңіз|сін|емін|еміз)',
    'тексер(?:іңіз|сін|емін|еміз)', 'аяқта(?:ңыз|сын|ймын|ймыз)',
    'жаңарт(?:ыңыз|сын|амын|амыз)', 'ұйымдастыр(?:ыңыз|сын|амын|амыз)',
    'өткіз(?:іңіз|сін|емін|еміз)', 'бер(?:іңіз|сін|емін|еміз)'
  ].join('|');
  const ACTION = new RegExp(`(?:^|[^${LOWER}${UPPER}])(${ACTION_WORDS})(?=$|[^${LOWER}${UPPER}])`, 'iu');
  const MODAL = /(?:^|\s)(?:нужно|надо|необходимо|поручаю|прошу|пожалуйста|тапсырма|керек|қажет)(?:\s|:|$)/iu;
  const NOMINAL = /(?:^|\s)(?:и\s+)?мне\s+(?:по итогам[^—:]*[—:]\s*)?(?:короткую\s+)?(?:справку|отч[её]т|смету)/iu;
  const SELF_ACTION = /(?:^|\s)(?:я\s+)?(?:подготовлю|отправлю|направлю|проверю|сделаю|обновлю|найду|организую|предоставлю|зафиксирую|завершу|пришлю|составлю|дам|проведу|уточню|передам|пропишу|согласую|дайындаймын|жіберемін|тексеремін|аяқтаймын|жаңартамын)(?:\s|[,.!?]|$)/iu;
  const ONLY_ACK = /^(?:(?:хорошо|понял[аи]?|принял[аи]?|согласен|согласна|ладно|да|жақсы)[,.!]?\s*)*(?:(?:на\s+этой\s+неделе|завтра|сегодня)\s+)?(?:сделаю|сделаем|организуем|выполним|істеймін)[.!]?$/iu;

  function hasDirective(text) { return ACTION.test(text) || MODAL.test(text) || NOMINAL.test(text); }

  function isActionable(text) {
    if (!hasDirective(text) || ONLY_ACK.test(compact(text))) return false;
    if (/\?\s*$/.test(text)) return false;
    if (/(?:если\s+бы|можно\s+было\s+бы|могли\s+бы|предлагаю\s+подумать|не\s+(?:надо|нужно|необходимо|поручаю|требуется)|не\s+будем|не\s+станем|не\s+должны|қажет\s+емес)/iu.test(text)) return false;
    const action = ACTION.exec(text);
    if (action && /(?:^|\s)не\s*$/iu.test(text.slice(0, action.index + (action[0].length - action[1].length)))) return false;
    if (/(?:может|мог|могла|обсуждали|раньше|вчера)\s+(?:бы\s+)?(?:подготовить|отправить|организовать)/iu.test(text)) return false;
    // A need must contain an action, not just «нужно время» or «нужен отчёт».
    if (!action && !NOMINAL.test(text) && !/(?:[а-яё]+(?:ть|ти)|дайындау|жіберу|тексеру|аяқтау|ұйымдастыру)/iu.test(text)) return false;
    return true;
  }

  const DATE_PATTERNS = [
    /(?:не\s+позднее|до|к)\s+(?:конца|начала|середины)\s+(?:(?:этой|следующей|рабочей)\s+)?(?:недели|месяца|квартала|года|дня)/giu,
    /(?:не\s+позднее|до|к|на|в)\s+(?:(?:этот|этого|этой|следующий|следующего|следующей)\s+)?(?:понедельник[а-я]*|вторник[а-я]*|сред[ауы]|четверг[а-я]*|пятниц[ауы]|суббот[ауы]|воскресень[ея])/giu,
    /на\s+(?:этой|следующей|текущей)\s+неделе/giu,
    /(?:за|через|в\s+течение)\s+(?:(?:один|одну|одного|два|две|двух|три|трех|трёх|четыре|четырех|четырёх|пять|пяти|шесть|шести|семь|семи|десять|десяти|\d+)\s+)?(?:рабочих\s+)?(?:час(?:а|ов)?|день|дня|дней|недел(?:ю|и|ь)|месяц(?:а|ев)?)/giu,
    /(?:не\s+позднее|до|к|на)\s+\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?(?:\s+(?:в|до)\s+\d{1,2}:\d{2})?/giu,
    /(?:не\s+позднее|до|к|на)\s+\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+\d{4})?(?:\s+(?:в|до)\s+\d{1,2}:\d{2})?/giu,
    /(?:сегодня|завтра|послезавтра)(?:\s+(?:утром|вечером|до\s+\d{1,2}(?::\d{2})?))?/giu,
    /(?:дүйсенбі|сейсенбі|сәрсенбі|бейсенбі|жұма|сенбі|жексенбі)(?:ға|ге)?\s+(?:дейін|күні)/giu,
    /(?:апта|ай)\s+соңына\s+дейін/giu,
    /(?:осы|келесі)\s+апта(?:да|ның\s+соңына\s+дейін)?/giu,
    /(?:бір|екі|үш|төрт|бес|\d+)\s+(?:күн|апта|ай)\s+ішінде/giu,
    /\d{1,2}\s+(?:қаңтар|ақпан|наурыз|сәуір|мамыр|маусым|шілде|тамыз|қыркүйек|қазан|қараша|желтоқсан)(?:ға|ге|қа|ке)?\s+дейін/giu,
    /(?:бүгін|ертең|бүрсігүні)/giu,
    /по\s+итогам\s+(?:этого\s+)?совещания/giu
  ];

  function deadlines(text) {
    const result = [];
    for (const pattern of DATE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        if (!result.some(item => match.index >= item.index && match.index < item.index + item.text.length)) {
          result.push({text: match[0], index: match.index});
        }
      }
    }
    return result.sort((a, b) => a.index - b.index);
  }

  function splitActions(sentence) {
    const pieces = sentence.split(/;\s*|,\s*|\s+и\s+(?=(?:подготов|отправ|обнов|зафиксир|провер|направ|состав|заверш|пришл|найд|пропиш|привлек)[а-яё]*\s)/iu);
    const clauses = [];
    let buffer = '';
    for (const piece of pieces) {
      if (buffer && hasDirective(buffer) && hasDirective(piece) && !/^(?:чтобы|котор|что\s|если\s)/iu.test(piece)) {
        clauses.push(buffer);
        buffer = piece;
      } else buffer += (buffer ? ', ' : '') + piece;
    }
    if (buffer) clauses.push(buffer);
    return clauses;
  }

  function resolveName(raw, people) {
    const value = compact(raw).replace(/[,:.!?]+$/, '');
    const exact = [...people.keys()].find(name => lower(name) === lower(value));
    if (exact) return exact;
    const first = [...people.keys()].filter(name => lower(name.split(' ')[0]) === lower(value));
    return first.length === 1 ? first[0] : value;
  }

  function explicitOwner(text, people) {
    const fullNames = [...people.keys()].sort((a, b) => b.length - a.length);
    for (const name of fullNames) {
      const aliases = [name, name.split(' ')[0]];
      for (const alias of aliases) {
        const p = escapeRE(alias);
        if (new RegExp(`(?:^|[,.]\\s*)(?:а\\s+|и\\s+)?${p}\\s*,|(?:пусть|поручаю|прошу|ответственн(?:ый|ая))\\s*:?\\s*${p}(?=\\s|,|$)`, 'iu').test(text)) return name;
        if (new RegExp(`^${p}\\s+(?:(?:до|к|на|за)\\s+[^,]{0,50}\\s+)?(?:подготовит|направит|отправит|проверит|организует|сделает|найдёт|найдет)`, 'iu').test(text)) return name;
      }
    }
    const named = new RegExp(`(?:пусть|ответственн(?:ый|ая))\\s*:?\\s*(${FULL_NAME}|${WORD})`, 'u').exec(text)
      || new RegExp(`^(?:Хорошо,\\s*|Пожалуйста,\\s*)?(${FULL_NAME}|${WORD}),\\s*(?:пожалуйста[, ]*|до\\s+[^,]{0,40}\\s+)?`, 'u').exec(text);
    if (named && !/^(?:Хорошо|Коллеги|Пожалуйста|Тогда|Смотрите|Жақсы|Понял|Поняла|Поняли|Принял|Приняла|Согласен|Согласна|Отлично|Да|Нет)$/u.test(named[1])) return resolveName(named[1], people);
    return null;
  }

  function inferOwner(clause, sentence, utterance, index, utterances, people, addressee) {
    const explicit = explicitOwner(clause, people) || (!/^(?:а\s+)?вы\s/iu.test(clause) && explicitOwner(sentence, people));
    if (explicit) return {owner: explicit, assignmentBasis: 'Имя явно указано в поручении', inferred: false};
    if (SELF_ACTION.test(clause) && !isUnknown(utterance.speaker)) {
      return {owner: utterance.speaker, assignmentBasis: 'Обязательство от первого лица', inferred: false};
    }
    const next = utterances.slice(index + 1, index + 3).find(item => item.speaker !== utterance.speaker && !isUnknown(item.speaker));
    const previous = utterances.slice(Math.max(0, index - 2), index).reverse().find(item => item.speaker !== utterance.speaker && !isUnknown(item.speaker));
    const inferred = addressee || (next && /^(?:хорошо|понял|поняла|принял|приняла|сделаю|согласен|согласна|жақсы)/iu.test(next.text) ? next.speaker : previous?.speaker);
    if (inferred && inferred !== utterance.speaker) {
      return {owner: inferred, assignmentBasis: 'Предположение по обращению и соседним репликам; требуется подтверждение', inferred: true};
    }
    return {owner: UNKNOWN, assignmentBasis: 'Ответственный не назван', inferred: true};
  }

  function taskTitle(clause, owner) {
    let title = compact(clause).replace(/^(?:(?:хорошо|тогда|смотрите|давайте так|прямое решение|пожалуйста|и|а)\s*[,—:]?\s+)+/iu, '');
    title = title.replace(/^пусть\s+/iu, '');
    if (owner !== UNKNOWN) {
      for (const name of [owner, owner.split(' ')[0]]) title = title.replace(new RegExp(`^${escapeRE(name)}(?=\\s|,)\\s*,?\\s*`, 'iu'), '');
    }
    title = title.replace(/^(?:вы|пожалуйста)\s*[, ]\s*/iu, '').replace(/[.!]$/, '');
    for (const match of deadlines(title)) title = title.replace(match.text, '');
    title = compact(title).replace(/^(?:параллельно\s+|тогда\s+|давайте\s+так\s*[—:]\s*)/iu, '');
    const infinitives = [
      [/подготов(?:ь|ьте|ит|лю|им)/iu, 'Подготовить'], [/собер(?:и|ите|ёт|ет|у|ём|ем)/iu, 'Собрать'],
      [/организ(?:уй|уйте|ует|ую|уем)/iu, 'Организовать'], [/провер(?:ь|ьте|ит|ю|им)/iu, 'Проверить'],
      [/отправ(?:ь|ьте|ит|лю|им)/iu, 'Отправить'], [/направ(?:ь|ьте|ит|лю|им)/iu, 'Направить'],
      [/най(?:ди|дите|дёт|дет|ду|дём|дем)|ищи(?:те)?/iu, 'Найти'], [/зафиксир(?:уй|уйте|ует|ую|уем)/iu, 'Зафиксировать'],
      [/обнов(?:и|ите|ит|лю|им)/iu, 'Обновить'], [/пропиш(?:и|ите|ет|у|ем)/iu, 'Прописать'],
      [/привлек(?:и|ите|у|ут)|привлеч(?:ёт|ет|ём|ем)/iu, 'Привлечь'], [/дам/iu, 'Предоставить']
    ];
    for (const [pattern, replacement] of infinitives) {
      const anchored = new RegExp(`^${pattern.source}(?=\\s|$)`, 'iu');
      if (anchored.test(title)) { title = title.replace(anchored, replacement); break; }
    }
    return shorten(title.charAt(0).toLocaleUpperCase('ru') + title.slice(1), 280);
  }

  function taskKey(task) {
    const title = lower(task.title);
    const anchors = [
      ['претенз', 'претензия'], ['справк', 'справка'], ['смет', 'смета'],
      ['уведомлен', 'уведомление'], ['шаблон', 'шаблон'], ['график', 'график'],
      ['тренер', 'тренер'], ['групп', 'группы']
    ];
    let key = anchors.find(([stem]) => title.includes(stem))?.[1];
    if (!key && /поставщик/.test(title) && /най|ищ|поиск/.test(title)) key = 'поиск поставщика';
    if (!key && /совещан/.test(title) && /собер|организ|провед/.test(title)) key = 'совещание';
    if (!key) key = title.replace(/[.,!?]/g, '').replace(/^(?:нужно|надо|необходимо|прошу|поручаю)\s+/u, '');
    return lower(task.owner) + '|' + key;
  }

  function extractTasks(utterances, people) {
    const tasks = [];
    let addressee = null;
    utterances.forEach((utterance, sourceIndex) => {
      const names = [...people.keys()].filter(name => name !== utterance.speaker);
      const addressed = names.find(name => new RegExp(`${escapeRE(name)}\\s*,`, 'iu').test(utterance.text));
      if (addressed) addressee = addressed;
      else if (addressee === utterance.speaker) addressee = null;
      for (const sentence of sentenceParts(utterance.text)) {
        if (/Подытожим\s*[—:]/iu.test(sentence)) continue;
        const clauses = splitActions(sentence);
        for (const clause of clauses) {
          if (!isActionable(clause)) continue;
          const owner = inferOwner(clause, sentence, utterance, sourceIndex, utterances, people, addressee);
          const contractual = /(?:срок\s+выставления|после\s+выполнения\s+работ|срок\s+оплаты|штрафн\S*\s+санкц)/iu.test(clause);
          const matches = contractual ? [] : deadlines(clause);
          const due = matches.length ? matches.map(match => match.text).join('; ') : UNKNOWN;
          tasks.push({
            id: '', title: taskTitle(clause, owner.owner), owner: owner.owner, due, status: 'В работе',
            source: clause, sourceIndex,
            needsReview: owner.inferred || due === UNKNOWN || matches.length > 1 || contractual,
            assignmentBasis: owner.assignmentBasis + (contractual ? '. Срок в условии договора не принят за срок исполнения поручения' : '')
          });
        }
      }
    });
    const unique = new Map();
    for (const task of tasks) {
      const key = taskKey(task);
      const previous = unique.get(key);
      if (!previous) unique.set(key, task);
      else if ((previous.due === UNKNOWN && task.due !== UNKNOWN) || (previous.needsReview && !task.needsReview)
        || (previous.assignmentBasis.startsWith('Предположение') && !task.assignmentBasis.startsWith('Предположение') && previous.due === task.due)) unique.set(key, task);
    }
    return [...unique.values()].map((task, index) => ({...task, id: `task-${index + 1}`}));
  }

  function summarize(utterances, tasks) {
    const candidates = [];
    utterances.forEach((utterance, sourceIndex) => {
      sentenceParts(utterance.text).forEach(sentence => {
        if (sentence.length < 35 || ONLY_ACK.test(sentence) || /\?\s*$/.test(sentence)) return;
        if (/^(?:коллеги|начинаем|начн[её]м|всем\s+привет|добрый\s+день|формат\s+сегодня|спасибо|все\s+свободны|хорошо,?\s+(?:понял|сделаем))/iu.test(sentence)) return;
        if (hasDirective(sentence)) return;
        const score = (/(?:\d+\s*%|\d+\s*(?:из|процент))/u.test(sentence) ? 7 : /\d/u.test(sentence) ? 2 : 0)
          + (/проблем|риск|отставан|просроч|задерж|срыв|недобор|не\s+успева|очеред|путаниц|тәуекел|мәселе/iu.test(sentence) ? 5 : 0)
          + (/показател|план|бюджет|выпуск|освоени|готов|результат|орындал/iu.test(sentence) ? 3 : 0)
          + (/решили|согласовали|утвердили|договорились|решение|келістік|шешім/iu.test(sentence) ? 4 : 0);
        if (score) candidates.push({sentence, sourceIndex, score});
      });
    });
    const chosen = candidates.sort((a, b) => b.score - a.score).filter((candidate, index, all) => all.findIndex(item => lower(item.sentence) === lower(candidate.sentence)) === index).slice(0, 5).sort((a, b) => a.sourceIndex - b.sourceIndex);
    const highlights = chosen.map(item => shorten(item.sentence, 270));
    const decisions = utterances.flatMap(item => sentenceParts(item.text)).filter(sentence => /(?:^|\s)(?:решили|согласовали|утвердили|договорились|келістік|шешім)/iu.test(sentence) && !/\?|не\s+(?:решили|согласовали|утвердили|договорились)|если\s+бы/iu.test(sentence)).slice(0, 4).map(text => shorten(text, 240));
    const corpus = utterances.map(item => item.text).join(' ');
    const themes = [
      [/выпуск\s+продукц|производственн\S*\s+показател/iu, 'производственные показатели'],
      [/поставщик|поставк\S*\s+сырья/iu, 'снабжение и работу с поставщиками'],
      [/инвестпрограмм|инвестици|освоени\S*\s+(?:\d+%\s+)?(?:от\s+)?(?:планов\S*\s+)?бюджет/iu, 'выполнение инвестиционной программы'],
      [/сертификат|переаттестаци|охраны\s+труда|промбезопасност/iu, 'обучение и безопасность персонала'],
      [/подрядчик|договор\S*\s+(?:работ|услов|срок)|счета\s+с\s+задержк/iu, 'сроки и условия работы с подрядчиками'],
      [/тестирован|регрессионн|чек-лист|запуск\S*\s+личного\s+кабинета/iu, 'готовность продукта и тестирование']
    ].filter(([pattern]) => pattern.test(corpus)).map(([, label]) => label);
    const parts = themes.length ? ['Обсудили ' + themes.join(', ') + '.'] : [];
    if (decisions.length) parts.push(...decisions.slice(0, 1));
    if (!parts.length && tasks.length) {
      parts.push('Основные действия: ' + tasks.slice(0, 3).map(task => shorten(task.title, 100)).join('; ') + '.');
    }
    if (!parts.length) parts.push('В расшифровке не обнаружены явные решения, показатели или поручения. Проверьте исходный текст.');
    return {summary: parts.join(' '), highlights, decisions};
  }

  function analyzeTranscript(input) {
    const warnings = [];
    const {utterances, people} = parseTranscript(input, warnings);
    const tasks = extractTasks(utterances, people);
    const summary = summarize(utterances, tasks);
    if (tasks.some(task => /Предположение/.test(task.assignmentBasis))) warnings.push('Часть ответственных предположена по контексту диалога. Подтвердите их перед выдачей поручений.');
    if (tasks.some(task => task.owner === UNKNOWN)) warnings.push('В части поручений ответственный не указан.');
    if (tasks.some(task => task.due === UNKNOWN)) warnings.push('В части поручений не указан срок. Относительные сроки сохранены как в исходном тексте.');
    if (!tasks.length && utterances.length) warnings.push('Явные поручения не найдены. Локальные правила могут пропускать неявные формулировки.');
    return {
      ...summary, utterances, people: [...people.entries()], tasks, warnings, method: 'local-rules',
      stats: {utterances: utterances.length, participants: people.size, tasks: tasks.length,
        needsReview: tasks.filter(task => task.needsReview).length,
        characters: utterances.reduce((total, item) => total + item.text.length, 0)}
    };
  }

  return {analyzeTranscript};
}));
