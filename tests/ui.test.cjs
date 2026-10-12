const { test }=require('node:test');
const assert=require('node:assert/strict');
const { JSDOM }=require('jsdom');
const { read,until }=require('./helpers.cjs');
function setup(html,url,settings={},success=false){
 const dom=new JSDOM(html,{url,runScripts:'outside-only'}),win=dom.window;const messages=[];let clipboard='';
 win.chrome={storage:{local:{get(keys,cb){const result={settings:{defaultSuffix:'-copy',defaultLocalDir:'~/Projects',autoSubmit:false,...settings},history:[{targetName:'<img src=x onerror=alert(1)>',sourceUrl:'<em>fake</em>',createdAt:'2026-09-25T00:00:00Z',status:'submission_requested'}]};if(cb)cb(result);return Promise.resolve(result);},set(){return Promise.resolve();}}},runtime:{sendMessage:async message=>{messages.push(message);return {success,error:'模拟后台拒绝'};},onMessage:{addListener(){}}},tabs:{query:async()=>[{id:1,url:'https://github.com/example/demo'}],sendMessage:async()=>({currentUser:'browser-user',isFork:false})}};
 Object.defineProperty(win.navigator,'clipboard',{value:{writeText:async text=>{clipboard=text;}}});
 win.eval(read('shared.js'));
 return {dom,win,messages,clipboard:()=>clipboard};
}
test('popup uses saved settings, safe history, working generator and visible background errors',async()=>{
 const p=setup(read('popup.html'),'https://extension.example/popup.html');try{
  p.win.eval(read('popup.js'));
  await until(()=>p.win.document.getElementById('target-repo-name').value==='demo-copy');
  p.win.document.getElementById('btn-copy-cli').click();await until(()=>p.clipboard().length>0);
  assert(!p.clipboard().includes('<your-username>'));assert(p.clipboard().includes('api --hostname github.com user'));
  p.win.document.querySelector('[data-target="tab-history"]').click();
  await until(()=>p.win.document.querySelector('.history-item'));
  assert.equal(p.win.document.querySelectorAll('.history-item img,.history-item em').length,0);
  assert.match(p.win.document.querySelector('.history-item').textContent,/结果待确认/);
  p.win.document.getElementById('btn-cloud-import').click();await until(()=>p.win.document.getElementById('toast-msg').textContent==='模拟后台拒绝');
  assert.equal(p.win.document.getElementById('btn-cloud-import').disabled,false);
  assert.equal(p.messages.at(-1).data.mode,'automatic');
  p.win.document.getElementById('manual-source-url').value='https://evil.example/owner/repo';
  p.win.document.getElementById('manual-target-name').value='valid';const count=p.messages.length;
  p.win.document.getElementById('btn-manual-import').click();await new Promise(r=>setTimeout(r,10));assert.equal(p.messages.length,count);
 }finally{p.dom.window.close();}
});
test('repository modal escapes metadata and generates from latest SPA URL',async()=>{
 const p=setup('<meta name="user-login" content="&quot;&gt;&lt;img src=x&gt;"><ul class="pagehead-actions"><li>Fork</li></ul>','https://github.com/example/first');try{
  p.win.eval(read('content_repo.js'));await until(()=>p.win.document.getElementById('f2p-private-copy-btn'));
  p.win.history.pushState(null,'','/example/second');
  p.win.document.getElementById('f2p-more-options').click();
  await until(()=>p.win.document.getElementById('f2p-modal-overlay'));
  assert.equal(p.win.document.getElementById('f2p-target-name').value,'second-copy');
  assert.equal(p.win.document.querySelectorAll('#f2p-modal-overlay img').length,0);
  p.win.document.getElementById('f2p-copy-cli').click();await until(()=>p.clipboard().length>0);
  assert(p.clipboard().includes('example/second.git'));
  p.win.document.getElementById('f2p-target-name').value='$(printf BAD)';
  p.win.document.getElementById('f2p-target-name').dispatchEvent(new p.win.Event('input'));
  p.win.document.getElementById('f2p-start-cloud-import').click();await new Promise(r=>setTimeout(r,10));
  assert.equal(p.messages.length,0);assert(p.win.document.querySelector('#f2p-modal-overlay [role="alert"]').textContent.length>0);
 }finally{p.dom.window.close();}
});

test('repository primary button starts from latest URL with no modal or required input',async()=>{
 const p=setup('<ul class="pagehead-actions"><li>Fork</li></ul>','https://github.com/example/first');try{
  p.win.eval(read('content_repo.js'));await until(()=>p.win.document.getElementById('f2p-private-copy-btn'));
  p.win.history.pushState(null,'','/example/second');p.win.document.getElementById('f2p-private-copy-btn').click();
  await until(()=>p.messages.length===1);
  assert.deepEqual(JSON.parse(JSON.stringify(p.messages[0])),{action:'START_IMPORT',data:{sourceUrl:'https://github.com/example/second.git',targetName:'second-copy',autoRename:true,mode:'automatic'}});
  assert.equal(p.win.document.getElementById('f2p-modal-overlay'),null);
 }finally{p.dom.window.close();}
});

test('successful primary launch is deduplicated but SPA navigation enables the next repository',async()=>{
 const p=setup('<ul class="pagehead-actions"><li>Fork</li></ul>','https://github.com/example/first',{},true);try{
  p.win.eval(read('content_repo.js'));await until(()=>p.win.document.getElementById('f2p-private-copy-btn'));
  const button=p.win.document.getElementById('f2p-private-copy-btn');button.click();button.click();await until(()=>p.messages.length===1);assert(button.disabled);
  p.win.history.pushState(null,'','/example/second');p.win.document.dispatchEvent(new p.win.Event('turbo:load'));
  assert.equal(button.disabled,false);button.click();await until(()=>p.messages.length===2);assert.equal(p.messages[1].data.sourceUrl,'https://github.com/example/second.git');
 }finally{p.dom.window.close();}
});

test('import progress 500 page shows waiting banner for submitted task and updates when private repository files are ready',async()=>{
 const html='<title>Server Error · GitHub</title><ul class="pagehead-actions"><li>Fork</li></ul><p>Looks like something went wrong!</p>';
 const p=setup(html,'https://github.com/ryumu1008/rea-private/import',{},true);
 try{
  const ticks=[];p.win.setInterval=fn=>{ticks.push(fn);return ticks.length;};p.win.clearInterval=()=>{};
  let fetchMode='empty';
  p.win.fetch=async()=>({
   ok:fetchMode!=='500',
   url:'https://github.com/ryumu1008/rea-private',
   text:async()=>fetchMode==='ready'
    ?'<meta name="route-controller" content="files"><meta name="octolytics-dimension-repository_nwo" content="ryumu1008/rea-private"><meta name="octolytics-dimension-repository_public" content="false">'
    :fetchMode==='public'
    ?'<meta name="route-controller" content="files"><meta name="octolytics-dimension-repository_nwo" content="ryumu1008/rea-private"><meta name="octolytics-dimension-repository_public" content="true">'
    :'<meta name="route-controller" content="repositories">'
  });
  p.win.chrome.runtime.sendMessage=async msg=>{
   p.messages.push(msg);
   if(msg.action==='GET_SUBMITTED_IMPORT')return {success:true,task:{id:'t1',sourceUrl:'https://github.com/morluto/rea.git',targetName:'rea-private',owner:'ryumu1008',fullRepo:'ryumu1008/rea-private',repoUrl:'https://github.com/ryumu1008/rea-private'}};
   return {success:false};
  };
  p.win.eval(read('content_repo.js'));
  await until(()=>p.win.document.getElementById('f2p-import-banner'));
  assert.equal(p.win.document.getElementById('f2p-private-copy-btn'),null);
  const banner=p.win.document.getElementById('f2p-import-banner');
  assert.equal(banner.getAttribute('translate'),'no');
  assert.match(banner.textContent,/源仓库分支和 PR 记录太多，请耐心等待/);
  assert.equal(banner.querySelector('.f2p-banner-btn').getAttribute('href'),'https://github.com/ryumu1008/rea-private');
  await until(()=>ticks.length===1);
  fetchMode='public';await ticks[0]();
  assert.equal(banner.classList.contains('f2p-banner-success'),false);
  fetchMode='ready';await ticks[0]();
  assert.equal(banner.classList.contains('f2p-banner-success'),true);
  assert.match(banner.textContent,/已复制成功！源仓库分支和 PR 记录太多，后台已完成导入/);
 }finally{p.dom.window.close();}
});

test('unrelated 500 /import page does not show banner and popup does not treat /import as source repository',async()=>{
 const p=setup('<title>Server Error · GitHub</title><p>Looks like something went wrong!</p>','https://github.com/ryumu1008/rea-private/import');
 try{
  p.win.chrome.runtime.sendMessage=async()=>({success:true,task:null});
  p.win.eval(read('content_repo.js'));
  await new Promise(r=>setTimeout(r,20));
  assert.equal(p.win.document.getElementById('f2p-import-banner'),null);
 }finally{p.dom.window.close();}
 const pop=setup(read('popup.html'),'https://extension.example/popup.html');
 try{
  pop.win.chrome.tabs.query=async()=>[{id:1,url:'https://github.com/ryumu1008/rea-private/import'}];
  pop.win.eval(read('popup.js'));
  await until(()=>pop.win.document.getElementById('no-repo-view').style.display==='block');
  assert.equal(pop.win.document.getElementById('current-repo-view').style.display,'none');
 }finally{pop.dom.window.close();}
});
