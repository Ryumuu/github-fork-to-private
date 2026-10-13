const { test } = require('node:test');
const assert = require('node:assert/strict');
const { worker, storage, until } = require('./helpers.cjs');

test('independent tasks, single claim, tab binding, document binding, and truthful history', async () => {
  const w = worker();
  const [a,b] = await Promise.all([w.start('task-a'),w.start('task-b')]);
  assert.notEqual(a.taskId,b.taskId);
  assert.equal(JSON.stringify(w.local.state).includes(a.taskId),false);
  assert.equal(JSON.stringify(w.local.state).includes(b.taskId),false);
  assert.equal((await w.send({action:'CLAIM_IMPORT',taskId:a.taskId},w.sender(b.tabId))).success,false);
  const claims = await Promise.all([1,2].map(()=>w.send({action:'CLAIM_IMPORT',taskId:a.taskId},w.sender(a.tabId))));
  assert.deepEqual(claims.map(x=>x.success).sort(),[false,true]);
  assert.equal((await w.send({action:'CLAIM_IMPORT',taskId:b.taskId},w.sender(b.tabId))).success,true);
  assert.equal((await w.send({action:'IMPORT_STATUS',taskId:a.taskId,status:'submission_requested'},w.sender(a.tabId,'other-document'))).success,false);
  assert.equal((await w.send({action:'IMPORT_STATUS',taskId:a.taskId,status:'submission_requested'},w.sender(a.tabId))).success,true);
  const h=w.local.state.history;
  assert.equal(h.find(x=>x.id===a.historyId).status,'submission_requested');
  assert.equal(h.find(x=>x.id===b.historyId).status,'ready');
  assert(w.session.state['f2p-task:'+b.taskId]);
  assert.equal(h.some(x=>x.status==='completed'),false);
  assert.equal((await w.send({action:'IMPORT_STATUS',taskId:a.taskId,status:'submission_requested'},w.sender(a.tabId))).success,false);
});
test('untrusted pages, bad inputs and expired tasks cannot start or claim',async()=>{
  const w=worker();
  const request={action:'START_IMPORT',data:{sourceUrl:'https://github.com/example/demo',targetName:'demo'}};
  for(const sender of [{id:'other',url:w.chrome.runtime.getURL('popup.html')},{id:w.chrome.runtime.id,url:'https://evil.example',frameId:0,tab:{id:1}}]) assert.equal((await w.send(request,sender)).success,false);
  for(const name of ['$(printf BAD)','a/b','..']) assert.equal((await w.start(name)).success,false);
  const a=await w.start();
  w.session.state['f2p-task:'+a.taskId].expiresAt=Date.now()-1;
  assert.equal((await w.send({action:'CLAIM_IMPORT',taskId:a.taskId},w.sender(a.tabId))).success,false);
  assert.equal((await w.send({action:'CLAIM_IMPORT',taskId:'not-a-task'},w.sender(a.tabId))).success,false);
});
test('worker restart cannot replay a consumed task; settings are authoritative',async()=>{
  const w=worker({local:storage({settings:{autoSubmit:false},history:[]})});
  const a=await w.start();
  const result=await w.send({action:'CLAIM_IMPORT',taskId:a.taskId},w.sender(a.tabId));
  assert.equal(result.task.autoSubmit,false);
  const next=w.restart();
  assert.equal((await next.send({action:'CLAIM_IMPORT',taskId:a.taskId},next.sender(a.tabId))).success,false);
});
test('failed navigation cleans only its task, while closed tabs are cancelled',async()=>{
  const failed=worker({failNavigation:true});
  assert.equal((await failed.start()).success,false);
  assert.equal(Object.keys(failed.session.state).length,0);
  assert.equal(failed.tabs.size,0);
  const w=worker(),a=await w.start('a'),b=await w.start('b');
  w.removed(a.tabId);
  await until(()=>!w.session.state['f2p-task:'+a.taskId]);
  assert(w.session.state['f2p-task:'+b.taskId]);
  assert.equal(w.local.state.history.find(x=>x.id===a.historyId).status,'cancelled');
});
test('upgrade preserves settings and converts unverified legacy success records',async()=>{
  const w=worker({local:storage({settings:{autoSubmit:false},pending_import:{nonce:'old'},history:[{id:1,targetName:'old',status:'completed',targetUrl:'https://github.com/wrong'}]})});
  w.installed();await until(()=>!w.local.state.pending_import);
  assert.equal(w.local.state.settings.autoSubmit,false);
  assert.equal(w.local.state.history[0].status,'legacy_unknown');
  assert.equal('targetUrl' in w.local.state.history[0],false);
});

test('automatic rename remains bound to its task, document, permission, and pre-submit state',async()=>{
 const w=worker(),a=await w.start(),b=await w.start();
 w.session.state['f2p-task:'+a.taskId].autoRename=true;
 await w.send({action:'CLAIM_IMPORT',taskId:a.taskId},w.sender(a.tabId));
 await w.send({action:'CLAIM_IMPORT',taskId:b.taskId},w.sender(b.tabId));
 const next=(task,sender=w.sender(task.tabId))=>w.send({action:'NEXT_IMPORT_NAME',taskId:task.taskId},sender);
 assert.equal((await next(a,w.sender(b.tabId))).success,false);
 assert.equal((await next(a,w.sender(a.tabId,'new-document'))).success,false);
 assert.equal((await next(b)).success,false);
 assert.equal((await next(a)).targetName,'demo-private-2');
 assert.equal(w.local.state.history.find(x=>x.id===a.historyId).targetName,'demo-private-2');
 await w.send({action:'IMPORT_STATUS',taskId:a.taskId,status:'submission_requested'},w.sender(a.tabId));
 assert.equal((await next(a)).success,false);
});
test('automatic rename is bounded and never exceeds GitHub name length',async()=>{
 const w=worker(),a=await w.start('x'.repeat(100));w.session.state['f2p-task:'+a.taskId].autoRename=true;
 await w.send({action:'CLAIM_IMPORT',taskId:a.taskId},w.sender(a.tabId));
 for(let i=2;i<=20;i++){
  const r=await w.send({action:'NEXT_IMPORT_NAME',taskId:a.taskId},w.sender(a.tabId));assert.equal(r.targetName.length,100);assert(r.targetName.endsWith('-'+i));
 }
 assert.equal((await w.send({action:'NEXT_IMPORT_NAME',taskId:a.taskId},w.sender(a.tabId))).success,false);
});
test('repository-button import opens in the same browser window',async()=>{
 const w=worker();const r=await w.send({action:'START_IMPORT',data:{sourceUrl:'https://github.com/example/demo',targetName:'demo-private',autoRename:true}},
  {id:w.chrome.runtime.id,frameId:0,tab:{id:8,windowId:42},url:'https://github.com/example/demo'});
 assert.equal(r.success,true);assert.equal(w.tabs.get(r.tabId).windowId,42);
});

test('explicit one-click automatic mode submits despite old manual setting without rewriting it',async()=>{
 const w=worker({local:storage({settings:{autoSubmit:false},history:[]})});
 const a=await w.start('demo-private',{mode:'automatic'}),r=await w.send({action:'CLAIM_IMPORT',taskId:a.taskId},w.sender(a.tabId));
 assert.equal(r.task.automatic,true);assert.equal(r.task.autoSubmit,true);assert.equal(w.local.state.settings.autoSubmit,false);
 const b=await w.start('manual-private'),manual=await w.send({action:'CLAIM_IMPORT',taskId:b.taskId},w.sender(b.tabId));
 assert.equal(manual.task.autoSubmit,false);assert.equal(manual.task.automatic,false);
});

test('GET_SUBMITTED_IMPORT only matches a submitted task on the same tab and target /import page',async()=>{
 const w=worker(),a=await w.start('rea-private'),b=await w.start('other-private');
 const progressSender=(tabId,url='https://github.com/Ryumuu/rea-private/import')=>({id:w.chrome.runtime.id,tab:{id:tabId},frameId:0,documentId:'doc-progress',url});
 assert.equal((await w.send({action:'GET_SUBMITTED_IMPORT'},progressSender(a.tabId))).task,null);
 await w.send({action:'CLAIM_IMPORT',taskId:a.taskId},w.sender(a.tabId));
 assert.equal((await w.send({action:'GET_SUBMITTED_IMPORT'},progressSender(a.tabId))).task,null);
 await w.send({action:'IMPORT_STATUS',taskId:a.taskId,status:'submission_requested'},w.sender(a.tabId));
 assert.equal((await w.send({action:'GET_SUBMITTED_IMPORT'},progressSender(b.tabId))).task,null);
 assert.equal((await w.send({action:'GET_SUBMITTED_IMPORT'},progressSender(a.tabId,'https://github.com/Ryumuu/wrong-private/import'))).task,null);
 assert.equal((await w.send({action:'GET_SUBMITTED_IMPORT'},progressSender(a.tabId,'https://github.com/Ryumuu/rea-private'))).task,null);
 const matched=await w.send({action:'GET_SUBMITTED_IMPORT'},progressSender(a.tabId));
 assert.equal(matched.success,true);
 assert.deepEqual(JSON.parse(JSON.stringify(matched.task)),{id:a.taskId,sourceUrl:'https://github.com/example/demo.git',targetName:'rea-private',owner:'Ryumuu',fullRepo:'Ryumuu/rea-private',repoUrl:'https://github.com/Ryumuu/rea-private'});
});
