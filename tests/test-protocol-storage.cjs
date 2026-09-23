const {test} = require('node:test');
const assert = require('node:assert/strict');
const store = require('../protocol-storage.js');
const fixture = () => ({type:'qorit-draft',version:1,sourceText:'Айжан: Есепті дайындаймын.',sourceDirty:false,metadata:{title:'Совещание',meetingDate:'2026-09-23'},result:{summary:'Отчёт',utterances:[{speaker:'Айжан',time:'00:05',text:'Есепті дайындаймын.'}],people:[['Айжан','']],tasks:[{title:'Есепті дайындау',owner:'Айжан',due:'завтра',dueDate:'2026-09-24',status:'Выполнено',needsReview:false,reviewed:true,sourceIndex:0,source:'Есепті дайындаймын.'}]}});
test('draft roundtrip preserves current reviewed task, date, source and Unicode',()=>{
 const parsed=store.parse(store.serialize(fixture()));
 assert.equal(parsed.result.tasks[0].status,'Выполнено');
 assert.equal(parsed.result.tasks[0].dueDate,'2026-09-24');
 assert.equal(parsed.result.tasks[0].reviewed,true);
 assert.equal(parsed.result.utterances[0].text,'Есепті дайындаймын.');
 assert.equal(parsed.sourceDirty,false);
});
test('empty draft is valid and does not pretend there is a result',()=>{
 assert.equal(store.parse(store.serialize({...fixture(),result:null})).result,null);
});
test('malformed and oversized imports are rejected, never used as trusted state',()=>{
 assert.throws(()=>store.parse('{'),/JSON/);
 assert.throws(()=>store.parse('{}'),/версии/);
 assert.throws(()=>store.serialize({...fixture(),sourceText:'x'.repeat(2000001)}),/длинный/);
 assert.throws(()=>store.serialize({...fixture(),result:{...fixture().result,tasks:{}}}),/список/);
});
test('server metadata, stable ids and task classification survive backup without local relabelling',()=>{
 const draft=fixture();
 Object.assign(draft.result,{method:'server',analysisMethod:'ollama:qwen',reportDate:'2026-09-23',reportTimezone:'Asia/Almaty'});
 Object.assign(draft.result.tasks[0],{id:'task-7b',urgency:'high',direction:'legal',sourceSpeaker:'SPEAKER_00',serverStatus:'completed',originalOwner:'Ерлан'});
 const result=store.parse(store.serialize(draft)).result;
 assert.equal(result.method,'server');assert.equal(result.analysisMethod,'ollama:qwen');
 assert.equal(result.reportDate,'2026-09-23');assert.equal(result.reportTimezone,'Asia/Almaty');
 for(const key of ['id','urgency','direction','sourceSpeaker','serverStatus','originalOwner']) assert.equal(result.tasks[0][key],draft.result.tasks[0][key]);
 draft.result.tasks[0].sourceSpeaker=null;draft.result.reportDate=null;
 const nullable=store.parse(store.serialize(draft)).result;
 assert.equal(nullable.tasks[0].sourceSpeaker,null);assert.equal(nullable.reportDate,null);
});
test('large server source and maximum supported owner/deadline/speaker strings are not truncated',()=>{
 const draft=fixture();draft.sourceText='Ә'.repeat(2000000);
 Object.assign(draft.result.utterances[0],{speaker:'А'.repeat(200),text:'Қ'.repeat(2000000)});
 Object.assign(draft.result.tasks[0],{owner:'Е'.repeat(2500),due:'Д'.repeat(2500)});
 const parsed=store.parse(store.serialize(draft));
 assert.equal(parsed.sourceText.length,2000000);assert.equal(parsed.result.utterances[0].text.length,2000000);
 assert.equal(parsed.result.utterances[0].speaker.length,200);
 assert.equal(parsed.result.tasks[0].owner.length,2500);assert.equal(parsed.result.tasks[0].due.length,2500);
});
test('server record capacity is 20000 turns and 5000 tasks with explicit rejection above limits',()=>{
 const draft=fixture();
 draft.result.utterances=Array.from({length:20000},()=>({speaker:'А',time:'—',text:'Б'}));
 draft.result.tasks=Array.from({length:5000},(_,index)=>({...fixture().result.tasks[0],id:'t-'+index}));
 const parsed=store.parse(store.serialize(draft));
 assert.equal(parsed.result.utterances.length,20000);assert.equal(parsed.result.tasks.length,5000);
 draft.result.tasks.push({...draft.result.tasks[0]});assert.throws(()=>store.serialize(draft),/список/);
 draft.result.tasks.pop();draft.result.utterances.push({...draft.result.utterances[0]});assert.throws(()=>store.serialize(draft),/список/);
});
test('unknown method, malformed metadata, invalid ids and non-record entries fail validation',()=>{
 for(const [key,value] of [['method','cloud'],['analysisMethod',42],['reportDate',{}],['reportTimezone',false]]) {
  const draft=fixture();draft.result[key]=value;assert.throws(()=>store.serialize(draft));
 }
 for(const [key,value] of [['id',{}],['id',Infinity],['sourceSpeaker',5],['urgency',{}],['direction',[]],['serverStatus',true]]) {
  const draft=fixture();draft.result.tasks[0][key]=value;assert.throws(()=>store.serialize(draft));
 }
 const draft=fixture();draft.result.utterances=[null];assert.throws(()=>store.serialize(draft),/объект/);
 draft.result=fixture().result;draft.result.people=['not a pair'];assert.throws(()=>store.serialize(draft),/список/);
});
test('20 MiB byte limit rejects oversized JSON rather than truncating',()=>{
 assert.equal(store.MAX_BYTES,20*1024*1024);
 assert.throws(()=>store.parse(' '.repeat(store.MAX_BYTES+1)),/20 МиБ/);
 const draft=fixture();draft.result.highlights=Array.from({length:6},()=> 'Ә'.repeat(2000000));
 assert.throws(()=>store.serialize(draft),/20 МиБ/);
});
test('unknown fields are discarded and out-of-range evidence links not restored',()=>{
 const draft=fixture();draft.result.tasks[0].sourceIndex=999;draft.result.tasks[0].onclick='alert(1)';
 const parsed=store.parse(store.serialize(draft));
 assert.equal(parsed.result.tasks[0].sourceIndex,null);
 assert.equal(parsed.result.tasks[0].onclick,undefined);
});
test('speaker mapping and numeric timestamps survive backup/restore',()=>{
 const draft=fixture();
 Object.assign(draft.result.utterances[0],{originalSpeaker:'SPEAKER_00',start:5,end:12});
 draft.result.tasks[0].originalOwner='SPEAKER_00';
 const parsed=store.parse(store.serialize(draft));
 assert.equal(parsed.result.utterances[0].originalSpeaker,'SPEAKER_00');
 assert.equal(parsed.result.tasks[0].originalOwner,'SPEAKER_00');
 assert.equal(parsed.result.utterances[0].end,12);
 draft.result.utterances[0].end=-1;
 assert.throws(()=>store.serialize(draft),/таймкоды/);
});
