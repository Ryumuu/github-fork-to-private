const { test }=require('node:test');
const assert=require('node:assert/strict');
const { JSDOM }=require('jsdom');
const { read,worker,until }=require('./helpers.cjs');
const base=`<form method="post" action="https://github.com/repositories/imports"><input id="vcs_url" name="vcs_url" required><input id="repository_name" name="repository[name]" required><input id="repository_visibility_public" type="radio" name="repository[visibility]" value="public" checked><input id="repository_visibility_private" type="radio" name="repository[visibility]" value="private"><button type="submit">Import</button></form>`;
// Structure observed on GitHub's signed-in /new/import page on 2026-09-26.
const modern=`<react-app app-name="repo-creation" initial-path="/new/import"><form novalidate><input name="The URL for your source repository"><input id="repository-name-input"><input type="radio" name="visibilityGroup" value="public" aria-checked="true" checked><input type="radio" name="visibilityGroup" value="private" aria-checked="false"><div class="InfoMessage-module__InfoMessage__fixture">You are creating a public repository in your personal account.</div><button type="submit">Begin import</button></form></react-app>`;
async function page(options={}){
 const w=worker();if(options.auto===false)w.local.state.settings.autoSubmit=false;
 const a=await w.start('demo-private',options.automatic?{mode:'automatic'}:{});
 if(options.autoRename)w.session.state['f2p-task:'+a.taskId].autoRename=true;const dom=new JSDOM(options.html||base,{url:'https://github.com/new/import'+(options.hash??'#f2p_task='+a.taskId),runScripts:'outside-only'});
 const win=dom.window,ticks=new Map();let intervalId=0,submits=0,nativeSubmitting=false,githubSubmits=0,nativeGetPrevented=false;
 let preparationProbes=0;
 const appState={source:'',name:'',visibility:'public'},submittedData=[];
 if(options.react){
  const app=win.document.querySelector('react-app');
  if(options.checkedButPublic){
   const radio=app.querySelector('[value="private"]');
   // A controlled radio whose tracker remembers true but app state remains Public.
   radio.checked=true;let tracked=true;
   app.addEventListener('click',event=>{
    if(event.target!==radio)return;
    if(tracked===radio.checked){event.stopImmediatePropagation();return;}
    tracked=radio.checked;
   },true);
  }
  if(options.probePreparation)app.addEventListener('click',event=>{
   if(event.target.value==='private' && !event.target.checked){
    preparationProbes++;
    const form=event.target.form;form.requestSubmit(form.querySelector('button[type="submit"]'));
    assert.equal(githubSubmits,0);assert.equal(submits,0);
   }
  },true);
  const renderText=()=>{
   app.querySelector('input[name="The URL for your source repository"]').value=appState.source;
   app.querySelector('#repository-name-input').value=appState.name;
  };
  let inputEvents=0;
  app.addEventListener('input',event=>{
   const key=event.target.id==='repository-name-input'?'name':event.target.name==='The URL for your source repository'?'source':null;
   if(!key || options.ignoreText || ++inputEvents<=(options.ignoreFirstInputs||0))return;
   appState[key]=event.target.value;
   event.target.defaultValue=event.target.value;
   if(key==='name'){
    if(options.retainStatusOnClear && !appState.name)return;
    app.querySelector('#RepoNameInput-is-available')?.remove();app.querySelector('#RepoNameInput-message')?.remove();
    if(!appState.name){event.target.removeAttribute('aria-invalid');return;}
    const status=win.document.createElement('span'),exists=options.takenNames?.includes(appState.name)||options.nameError;
    if(exists)event.target.setAttribute('aria-invalid','true');else event.target.removeAttribute('aria-invalid');
    status.id=exists?'RepoNameInput-message':'RepoNameInput-is-available';
    status.textContent=options.nameError||(exists?`The repository ${appState.name} already exists on this account`:`${appState.name} is available.`);
    if(options.translated && !options.nameError)status.innerHTML=exists?`仓库 <font>${appState.name}</font> 已存在于此账号`:`<font>${appState.name}</font> 可以使用。`;
    app.querySelector('form').append(status);
   }
  });
  app.addEventListener('change',event=>{
   if(event.target.name==='visibilityGroup' && !options.staleReactState){
    appState.visibility=event.target.value;
    for(const radio of app.querySelectorAll('[name=visibilityGroup]'))radio.setAttribute('aria-checked',String(radio.value===appState.visibility));
    app.querySelector('[class*="InfoMessage-module__InfoMessage__"]').textContent=options.translated?'您正在个人账户创建私有仓库。':`You are creating a ${event.target.value} repository in your personal account.`;
    if(options.replaceOnPrivate){
     for(const input of app.querySelectorAll('input[type="text"],#repository-name-input,input[name="The URL for your source repository"]'))input.replaceWith(input.cloneNode(true));
    }
    renderText();
   }
  });
  app.addEventListener('submit',event=>{githubSubmits++;submittedData.push({...appState});nativeGetPrevented=event.defaultPrevented;event.preventDefault();});
 }
 win.chrome={runtime:{getManifest:()=>({version:'1.1.3'}),sendMessage:msg=>w.send(msg,w.sender(a.tabId))}};
 const nativeTimeout=win.setTimeout.bind(win);
 let now=Date.now();win.Date.now=()=>now;
 win.setTimeout=(fn,ms)=>nativeTimeout(()=>{if(ms===100)now+=100;fn();},ms===10000?20:ms===100?0:ms);
 win.setInterval=fn=>{ticks.set(++intervalId,fn);return intervalId;};win.clearInterval=id=>ticks.delete(id);
 win.HTMLFormElement.prototype.requestSubmit=function(button){
  assert.equal(button.form,this);if(nativeSubmitting)return;
  nativeSubmitting=true;
  try{if(this.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true})))submits++;}
  finally{setTimeout(()=>{nativeSubmitting=false;},0);}
 };
 win.eval(read('shared.js'));win.eval(read('content_import.js'));
 if(options.hash)await new Promise(resolve=>setTimeout(resolve,10));
 else await until(()=>win.document.querySelector('#f2p-import-banner'));
 return {w,a,dom,win,ticks,appState,submittedData,preparationProbes:()=>preparationProbes,submits:()=>submits,githubSubmits:()=>githubSubmits,nativeGetPrevented:()=>nativeGetPrevented,async tick(){for(let i=0;i<3;i++)for(const fn of [...ticks.values()])fn();await new Promise(resolve=>setTimeout(resolve,10));}};
}
test('real DOM form is filled, Private selected, and only a submission attempt is recorded',async()=>{
 const p=await page();try{assert.equal(p.win.document.querySelector('#vcs_url').value,'https://github.com/example/demo.git');await p.tick();assert.equal(p.submits(),1);assert.equal(p.w.local.state.history[0].status,'submission_requested');await p.tick();assert.equal(p.submits(),1);}finally{p.dom.window.close();}
});
for(const [name,html] of [['missing source',base.replace('<input id="vcs_url" name="vcs_url" required>','')],['missing name',base.replace('<input id="repository_name" name="repository[name]" required>','')],['missing private',base.replace('<input id="repository_visibility_private" type="radio" name="repository[visibility]" value="private">','')],['wrong action',base.replace('https://github.com/repositories/imports','https://evil.example/import')],['different form',base.replace('<input id="repository_visibility_private"','</form><form method="post" action="https://github.com/new/import"><input id="repository_visibility_private"')]]){
 test(name+' stops the import',async()=>{const p=await page({html});try{await p.tick();assert.equal(p.submits(),0);assert.match(p.win.document.body.textContent,/已停止自动导入/);assert.equal(p.w.local.state.history[0].status,'needs_attention');}finally{p.dom.window.close();}});
}
test('switching to Public or editing source during countdown stops submission',async()=>{
 for(const modify of [win=>win.document.querySelector('#repository_visibility_public').click(),win=>{win.document.querySelector('#vcs_url').value='https://github.com/example/other';}]){
  const p=await page();try{modify(p.win);await p.tick();assert.equal(p.submits(),0);assert.equal(p.w.local.state.history[0].status,'needs_attention');}finally{p.dom.window.close();}
 }
});
test('legacy external hash cannot claim a task or submit',async()=>{const p=await page({hash:'#f2p=1&src=https://github.com/example/demo&name=demo&auto=1'});try{assert.equal(p.ticks.size,0);assert.equal(p.submits(),0);assert.equal(p.win.document.querySelector('#vcs_url').value,'');}finally{p.dom.window.close();}});
test('auto off and cancel prevent countdown while manual confirmation remains available',async()=>{
 for(const mode of ['off','cancel']){
  const p=await page({auto:mode!=='off'});try{
   if(mode==='cancel')p.win.document.querySelector('.f2p-banner-cancel-btn').click();
   await p.tick();assert.equal(p.submits(),0);
   p.win.document.querySelector('.f2p-banner-btn').click();await until(()=>p.submits()===1);assert.equal(p.w.local.state.history[0].status,'submission_requested');
  }finally{p.dom.window.close();}
 }
});

test('native GitHub submit uses the same guard, records attempt and cancels countdown',async()=>{
 const p=await page();try{
  const form=p.win.document.querySelector('form');
  form.requestSubmit(form.querySelector('button[type=submit]'));
  assert.equal(p.submits(),0);
  await until(()=>p.submits()===1);await p.tick();
  assert.equal(p.submits(),1);assert.equal(p.w.local.state.history[0].status,'submission_requested');
 }finally{p.dom.window.close();}
});
for(const attribute of ['formaction="https://evil.example/upload"','formmethod="get"','formnovalidate']){
 test('submitter override is rejected: '+attribute,async()=>{
  const p=await page({html:base.replace('<button type="submit">','<button type="submit" '+attribute+'>')});
  try{await p.tick();assert.equal(p.submits(),0);assert.match(p.win.document.body.textContent,/已停止自动导入/);}finally{p.dom.window.close();}
 });
}

test('current GitHub React importer receives one guarded submission and cannot fall back to GET',async()=>{
 const p=await page({html:modern,react:true});try{
  assert.equal(p.win.document.querySelector('input[name="The URL for your source repository"]').value,'https://github.com/example/demo.git');
  assert.equal(p.win.document.querySelector('#repository-name-input').value,'demo-private');
  await p.tick();assert.equal(p.githubSubmits(),1);assert.equal(p.submits(),0);assert.equal(p.nativeGetPrevented(),true);
  assert.equal(p.w.local.state.history[0].status,'submission_requested');
  await p.tick();assert.equal(p.githubSubmits(),1);
 }finally{p.dom.window.close();}
});
test('React native button follows the same guarded path',async()=>{
 const p=await page({html:modern,react:true,auto:false});try{
  const form=p.win.document.querySelector('form');form.requestSubmit(form.querySelector('button'));
  await until(()=>p.githubSubmits()===1);assert.equal(p.nativeGetPrevented(),true);assert.equal(p.submits(),0);
 }finally{p.dom.window.close();}
});
test('React app without its submit handler never sends a native GET',async()=>{
 const p=await page({html:modern.replace('creating a public','creating a private')});try{
  await p.tick();assert.equal(p.submits(),0);
 }finally{p.dom.window.close();}
});
test('React checked radio with stale public app state is blocked',async()=>{
 const p=await page({html:modern,react:true,staleReactState:true});try{
  await p.tick();assert.equal(p.githubSubmits(),0);assert.equal(p.submits(),0);assert.equal(p.w.local.state.history[0].status,'needs_attention');
 }finally{p.dom.window.close();}
});
test('React switching to Public during the countdown is blocked',async()=>{
 const p=await page({html:modern,react:true});try{
  p.win.document.querySelector('[value="public"]').click();await p.tick();assert.equal(p.githubSubmits(),0);assert.equal(p.submits(),0);
 }finally{p.dom.window.close();}
});
for(const [label,html] of [
 ['wrong app identity',modern.replace('app-name="repo-creation"','app-name="other"')],
 ['wrong page identity',modern.replace('initial-path="/new/import"','initial-path="/new"')],
 ['explicit GET action',modern.replace('<form novalidate>','<form action="https://github.com/new/import" novalidate>')],
 ['external action',modern.replace('<form novalidate>','<form action="https://evil.example/" novalidate>')],
 ['submitter override',modern.replace('<button type="submit">','<button type="submit" formaction="https://evil.example/">')],
 ['duplicate source',modern.replace('<input id="repository-name-input">','<input name="The URL for your source repository"><input id="repository-name-input">')]
])test('React '+label+' is rejected',async()=>{
 const p=await page({html,react:true});try{await p.tick();assert.equal(p.githubSubmits(),0);assert.equal(p.submits(),0);assert.equal(p.w.local.state.history[0].status,'needs_attention');}finally{p.dom.window.close();}
});

for(const options of [{replaceOnPrivate:true},{ignoreFirstInputs:1}])test('controlled fields survive app setup: '+JSON.stringify(options),async()=>{
 const p=await page({html:modern,react:true,...options});try{
  await p.tick();assert.deepEqual(p.submittedData,[{source:'https://github.com/example/demo.git',name:'demo-private',visibility:'private'}]);
 }finally{p.dom.window.close();}
});
test('DOM text without application acknowledgement is never submitted',async()=>{
 const p=await page({html:modern,react:true,ignoreText:true});try{
  await p.tick();assert.equal(p.githubSubmits(),0);assert.equal(p.appState.source,'');assert.equal(p.w.local.state.history[0].status,'needs_attention');
 }finally{p.dom.window.close();}
});
test('one-click collision advances name and history before submitting, without overwriting existing names',async()=>{
 const p=await page({html:modern,react:true,autoRename:true,takenNames:['demo-private','demo-private-2']});try{
  await p.tick();assert.equal(p.githubSubmits(),1);assert.equal(p.submittedData[0].name,'demo-private-3');assert.equal(p.w.local.state.history[0].targetName,'demo-private-3');
 }finally{p.dom.window.close();}
});
test('custom-name collision stops instead of silently renaming',async()=>{
 const p=await page({html:modern,react:true,takenNames:['demo-private']});try{
  await p.tick();assert.equal(p.githubSubmits(),0);assert.match(p.win.document.body.textContent,/该仓库名不可用/);
 }finally{p.dom.window.close();}
});
test('rendered application text changed during countdown blocks submission even if DOM property still matches',async()=>{
 const p=await page({html:modern,react:true});try{
  const source=p.win.document.querySelector('input[name="The URL for your source repository"]');source.defaultValue='';
  await p.tick();assert.equal(p.githubSubmits(),0);
 }finally{p.dom.window.close();}
});

test('checked Private with stale Public state recovers and submits without user interaction',async()=>{
 const p=await page({html:modern,react:true,checkedButPublic:true,automatic:true,auto:false});try{
  await until(()=>p.githubSubmits()===1);assert.deepEqual(p.submittedData,[{source:'https://github.com/example/demo.git',name:'demo-private',visibility:'private'}]);
  assert.equal(p.ticks.size,0);assert.equal(p.win.document.querySelector('.f2p-banner-btn').hidden,true);
 }finally{p.dom.window.close();}
});
test('automatic mode still refuses a permanently stale Public state',async()=>{
 const p=await page({html:modern,react:true,checkedButPublic:true,staleReactState:true,automatic:true});try{
  assert.equal(p.githubSubmits(),0);assert.equal(p.submits(),0);assert.equal(p.w.local.state.history[0].status,'needs_attention');
 }finally{p.dom.window.close();}
});

test('submission is blocked during unchecked recovery, then occurs once after Private is confirmed',async()=>{
 const p=await page({html:modern,react:true,checkedButPublic:true,automatic:true,probePreparation:true});try{
  await until(()=>p.githubSubmits()===1);assert.equal(p.preparationProbes(),1);assert.equal(p.submittedData[0].visibility,'private');
 }finally{p.dom.window.close();}
});

test('translated and wrapped GitHub text still copies once, including automatic name retries and old auto-off setting',async()=>{
 const p=await page({html:modern,react:true,translated:true,automatic:true,auto:false,autoRename:true,takenNames:['demo-private','demo-private-2']});try{
  await until(()=>p.githubSubmits()===1);
  assert.deepEqual(p.submittedData,[{source:'https://github.com/example/demo.git',name:'demo-private-3',visibility:'private'}]);
  assert.equal(p.w.local.state.history[0].targetName,'demo-private-3');
 }finally{p.dom.window.close();}
});
for(const corrupt of ['missing aria','public aria','stale name','mixed status','invalid input'])test('rejects inconsistent application acknowledgement: '+corrupt,async()=>{
 const p=await page({html:modern,react:true});try{
  const doc=p.win.document;
  if(corrupt==='missing aria')doc.querySelector('[value="private"]').removeAttribute('aria-checked');
  if(corrupt==='public aria')doc.querySelector('[value="public"]').setAttribute('aria-checked','true');
  if(corrupt==='stale name')doc.querySelector('#RepoNameInput-is-available').textContent='demo-private-2 可以使用。';
  if(corrupt==='mixed status'){const error=doc.createElement('span');error.id='RepoNameInput-message';error.textContent='demo-private rejected';doc.querySelector('form').append(error);}
  if(corrupt==='invalid input')doc.querySelector('#repository-name-input').setAttribute('aria-invalid','true');
  await p.tick();assert.equal(p.githubSubmits(),0);assert.equal(p.submits(),0);assert.equal(p.w.local.state.history[0].status,'needs_attention');
  const banner=doc.querySelector('#f2p-import-banner');assert.equal(banner.getAttribute('translate'),'no');assert.match(banner.textContent,/v1\.1\.3/);
 }finally{p.dom.window.close();}
});
test('network errors without the exact candidate name never trigger automatic renaming or submission',async()=>{
 const p=await page({html:modern,react:true,automatic:true,autoRename:true,nameError:'检查失败，请稍后重试'});try{
  assert.equal(p.githubSubmits(),0);assert.equal(p.w.local.state.history[0].targetName,'demo-private');
  assert.equal(p.w.local.state.history[0].status,'needs_attention');
 }finally{p.dom.window.close();}
});

test('a previous error that survives clearing the name prevents another attempt',async()=>{
 const p=await page({html:modern,react:true,automatic:true,autoRename:true,takenNames:['demo-private'],retainStatusOnClear:true});try{
  assert.equal(p.githubSubmits(),0);assert.equal(p.w.local.state.history[0].status,'needs_attention');
  assert.match(p.win.document.body.textContent,/尚未重置名称检查/);
 }finally{p.dom.window.close();}
});
