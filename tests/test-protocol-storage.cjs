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
 assert.throws(()=>store.serialize({...fixture(),sourceText:'x'.repeat(200001)}),/длинный/);
 assert.throws(()=>store.serialize({...fixture(),result:{...fixture().result,tasks:{}}}),/список/);
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
