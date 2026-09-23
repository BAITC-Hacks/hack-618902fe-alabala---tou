const test = require('node:test');
const assert = require('node:assert/strict');
const {analyzeTranscript} = require('../transcript-analyzer.js');

const meeting = `Протокол совещания АО «Самрук-Казына Ондеу» Тема: Доклады по производственным показателям направлений Текст совещания Данияр Серикович (заместитель председателя правления) Коллеги, начинаем оперативное совещание. Формат сегодня такой — каждый докладывает по своему направлению: показатели, проблема, если есть, и что предлагаете. Начнём с Ботагоз Нурлановны. Ботагоз Нурлановна (директор департамента промышленной политики) По химическому направлению за август: выпуск продукции — 94% от плана, недобор в основном по полимерной группе. Проблема — срыв поставки сырья от казахстанского поставщика, третий месяц подряд задержка на 5–7 дней. Данияр Серикович Так, с этим тянуть нельзя. Смотрите — параллельно ищите второго поставщика, хотя бы на 30% объёма. Кто у вас курирует договорную работу? Ботагоз Нурлановна Есть юрист в департаменте, Ерлан. Данияр Серикович Хорошо, пусть Ерлан до конца недели подготовит претензию, а вы параллельно за две недели найдите альтернативного поставщика хотя бы для расчёта. Потом сравним условия и решим окончательно. Ботагоз Нурлановна Поняла, сделаем. Данияр Серикович Жандос Талгатович, по инвестициям что у нас? Жандос Талгатович (директор департамента инвестиций) По инвестпрограмме на сентябрь — освоение 68% от планового бюджета. Причина отставания — по трём проектам подрядчики не успевают со сдачей документации. Данияр Серикович Соберите совещание с подрядчиками на этой неделе, зафиксируйте новый график с промежуточными датами, а не только финальный срок сдачи. Жандос Талгатович Хорошо, на этой неделе организуем. Данияр Серикович И мне по итогам этого совещания — короткую справку, что решили с подрядчиками. Жандос Талгатович Сделаю. Данияр Серикович Ерболат Мухтарович, по вашему направлению? Ерболат Мухтарович (руководитель службы охраны труда) По травматизму показатель в норме. Но есть проблема по обучению — у нас 12% персонала с просроченными сертификатами по технике безопасности. Данияр Серикович Тогда давайте так — организуйте дополнительные группы, если нужно, привлеките внешнего сертифицированного тренера на подряд, чтобы закрыть очередь за месяц. Ерболат Мухтарович Понял, найду тренера, за неделю дам смету по доп.группам. Данияр Серикович Салтанат Ерболовна, у вас как с подрядчиками? Салтанат Ерболовна (руководитель управления взаимодействия с подрядчиками) Подрядчики выставляют счета с задержкой, из-за этого путаница в бюджете квартала. Данияр Серикович Тогда прямое решение — пропишите в новых договорах жёсткий срок выставления счёта, например пять рабочих дней после выполнения работ, и штрафную санкцию за нарушение. А по текущим договорам — направьте официальное уведомление. Салтанат Ерболовна Хорошо, подготовлю уведомление и обновлю шаблон договора. Данияр Серикович Отлично, коллеги. Подытожим — Ботагоз Нурлановна: претензия поставщику и поиск альтернативы за две недели. Жандос Талгатович: совещание с подрядчиками на этой неделе и справка мне. Все свободны, спасибо. Саммари по ключевым пунктам Выпуск продукции 94%. Поручения Поручение Ответственный Срок Другое поручение Ерлан завтра`;

test('flat real-world dialogue yields named turns, evidence, deadlines and issue summary', () => {
  const result = analyzeTranscript(meeting);
  assert.equal(result.method, 'local-rules');
  assert.ok(result.utterances.length >= 15, result.utterances.length);
  assert.ok(result.people.some(([name, role]) => name === 'Ботагоз Нурлановна' && role.includes('промышленной политики')));
  assert.ok(!result.utterances.some(item => item.speaker === 'Участник 1'));
  assert.ok(result.highlights.some(text => text.includes('94%')));
  assert.ok(result.highlights.some(text => text.includes('68%')));
  assert.ok(result.summary.includes('производственные показатели'));
  assert.ok(result.summary.length < 900);
  assert.ok(!result.summary.includes('Коллеги, начинаем'));
  const claim = result.tasks.find(task => /претензи/i.test(task.title));
  assert.equal(claim?.owner, 'Ерлан');
  assert.equal(claim?.due, 'до конца недели');
  assert.equal(claim?.needsReview, false);
  const supplier = result.tasks.find(task => /поставщик/i.test(task.title));
  assert.equal(supplier?.owner, 'Ботагоз Нурлановна');
  assert.equal(supplier?.due, 'за две недели');
  assert.equal(supplier?.needsReview, true);
  const contractor = result.tasks.find(task => /Собрать совещание/i.test(task.title));
  assert.equal(contractor?.owner, 'Жандос Талгатович');
  assert.equal(contractor?.due, 'на этой неделе');
  assert.ok(result.tasks.some(task => /смет/i.test(task.title) && task.owner === 'Ерболат Мухтарович' && task.due === 'за неделю'));
  assert.ok(!result.utterances.some(item => item.text.includes('Саммари по ключевым пунктам')));
  assert.ok(result.warnings.some(item => item.includes('исключены')));
  assert.ok(result.tasks.every(task => task.source && result.utterances[task.sourceIndex]));
});

test('different input produces different result and an unknown owner is never invented', () => {
  const a = analyzeTranscript('Пожалуйста подготовить отчёт до пятницы.');
  const b = analyzeTranscript('Необходимо проверить смету до 27.09.2026.');
  assert.equal(a.tasks.length, 1);
  assert.equal(a.tasks[0].owner, 'Не указан');
  assert.equal(a.tasks[0].due, 'до пятницы');
  assert.equal(b.tasks[0].due, 'до 27.09.2026');
  assert.notEqual(a.summary, b.summary);
  assert.notEqual(a.tasks[0].title, b.tasks[0].title);
});

test('line labels, timestamps, named addressees and first-person commitments are preserved', () => {
  const result = analyzeTranscript('10:02 Анна: Иван, подготовь отчёт до 26 сентября.\n10:04 Иван: Завтра отправлю презентацию.');
  assert.deepEqual(result.utterances.map(item => [item.time, item.speaker]), [['10:02', 'Анна'], ['10:04', 'Иван']]);
  assert.equal(result.tasks[0].owner, 'Иван');
  assert.equal(result.tasks[0].due, 'до 26 сентября');
  assert.equal(result.tasks[1].owner, 'Иван');
  assert.equal(result.tasks[1].due, 'Завтра');
  assert.ok(result.tasks.every(task => !task.needsReview));
});

test('Russian, Kazakh and mixed commitments are analyzed without external services', () => {
  const result = analyzeTranscript([
    {time: '01:00', speaker: 'Айжан', text: 'Есепті жұмаға дейін дайындаймын.'},
    {time: '01:05', speaker: 'Данияр', text: 'Айжан, пожалуйста, заверши регрессионные тесты до 26 сентября.'},
    {time: '01:10', speaker: 'Айжан', text: 'Бүгін чек-листті жаңартамын, итоговый отчёт отправлю в пятницу.'}
  ]);
  assert.ok(result.tasks.some(task => task.due === 'жұмаға дейін' && task.owner === 'Айжан'));
  assert.ok(result.tasks.some(task => task.due === 'Бүгін' && task.owner === 'Айжан'));
  assert.ok(result.tasks.some(task => task.due === 'в пятницу' && task.owner === 'Айжан'));
});

test('negated commands, hypotheticals, questions and acknowledgments create no task', () => {
  const result = analyzeTranscript('Анна: Не отправляйте старый отчёт. Не нужно готовить договор. Если бы можно было бы, подготовьте новый макет. Кто подготовит отчёт? Хорошо, сделаю.\nИван: Понял, сделаем.');
  assert.deepEqual(result.tasks, []);
});

test('multiple actions retain separate deadlines; missing deadlines stay unknown', () => {
  const result = analyzeTranscript('Анна: Иван, подготовь отчёт до пятницы, отправь презентацию завтра, обнови шаблон договора.\nИван: Принял.');
  assert.equal(result.tasks.length, 3);
  assert.deepEqual(result.tasks.map(task => task.due), ['до пятницы', 'завтра', 'Не указан']);
  assert.ok(result.tasks.every(task => task.owner === 'Иван'));
});

test('contract payment terms are not confused with a task due date', () => {
  const result = analyzeTranscript('Анна: Иван, пропиши в договорах срок выставления счёта, например пять рабочих дней после выполнения работ.\nИван: Хорошо.');
  assert.equal(result.tasks[0].due, 'Не указан');
  assert.equal(result.tasks[0].needsReview, true);
  assert.match(result.tasks[0].assignmentBasis, /условии договора/);
});

test('analysis is deterministic, does not mutate input, and long transcript is not copied to summary', () => {
  const input = [{speaker: 'Анна', time: '00:03', text: 'Выпуск продукции — 81% от плана. Проблема — задержка сырья. Иван, подготовь отчёт до пятницы.'}];
  const before = structuredClone(input);
  assert.deepEqual(analyzeTranscript(input), analyzeTranscript(input));
  assert.deepEqual(input, before);
  const long = analyzeTranscript(meeting.repeat(2));
  assert.ok(long.summary.length < 900);
  assert.ok(long.summary.length < meeting.length / 3);
});

test('empty text yields no fabricated participants or tasks', () => {
  const result = analyzeTranscript('   ');
  assert.equal(result.stats.tasks, 0);
  assert.deepEqual(result.people, []);
  assert.deepEqual(result.utterances, []);
});
