const { app, BrowserWindow, ipcMain, session } = require('electron');
const { join, resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const root = resolve(__dirname, '..');
const output = join(root, 'dist/qa');
const dataDir = join(output, 'run-'+Date.now());
mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir); app.setPath('sessionData', dataDir); app.setPath('crashDumps', join(dataDir, 'crashes'));
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
let window, fixture, alertWindow;
const failures = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const js = async (source) => { try { return await window.webContents.executeJavaScript(source, true); } catch(error) { console.error('UI QA script failed:',source); throw error; } };
async function until(source, message) { for (let i=0;i<80;i++) { if(await js(source)) return; await delay(50); } throw new Error(message); }
async function click(text) {
  await until(`[...document.querySelectorAll('button')].some(b=>(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}))`,'Button missing: '+text);
  await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}));b.click()})()`); await delay(180);
}
async function fill(selector, value) { await js(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing input');input.focus();const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`); await delay(180); }
async function capture(name) {
  await delay(150);
  const image = await window.webContents.capturePage(undefined, { stayHidden:true, stayAwake:true });
  const bitmap = image.toBitmap(); const colors = new Set();
  for(let offset=0;offset<bitmap.length;offset+=512) colors.add(bitmap.readUInt32LE(offset));
  assert(colors.size>10,'Screenshot is blank: '+name);
  writeFileSync(join(output,name+'.png'),image.toPNG());
}

async function checkAlertBounds() {
  alertWindow = new BrowserWindow({ show:false, width:1280, height:720, useContentSize:true, webPreferences:{ contextIsolation:true, nodeIntegration:false, offscreen:true, backgroundThrottling:false } });
  await alertWindow.loadURL(fixture.state.current.overlayUrl + '/overlay/alerts?preview=1');
  const run = (source) => alertWindow.webContents.executeJavaScript(source, true);
  let count = 0;
  for (const [width,height] of [[320,180],[1280,720],[1920,1080]]) {
    alertWindow.setContentSize(width,height);
    await delay(100);
    for (const anchor of ['topLeft','topRight','bottomLeft','bottomRight','center']) for (const layout of ['above','side']) {
      const message = { type:'alert', alert:{ id:'geometry', type:'donation', userName:'Ann', title:'Ann '+ 'ДлинноеИмя'.repeat(15), message:'Очень длинное сообщение зрителя. '.repeat(100), durationSec:5, sound:null, volume:0, image:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600"><rect width="1000" height="600" fill="#9146ff"/></svg>'), animation:'none', tts:false,
        style:{...fixture.settings.get('alerts').style,anchor,layout,x:anchor.endsWith('Right')?100:0,y:anchor.startsWith('bottom')?100:0,width:95,fontFamily:'system-ui',fontSize:70,messageFontSize:60,padding:40,safeMargin:24,imageWidth:1000,imageHeight:600} } };
      await run(`window.postMessage(${JSON.stringify(message)},location.origin)`);
      await delay(50);
      const rects = await run(`(()=>{const root=document.querySelector('.alert-position');if(!root)throw Error('No preview alert');return {width:innerWidth,height:innerHeight,rects:[root,...root.querySelectorAll('.alert,.title,.message,.media')].map(n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}})}})()`);
      for (const r of rects.rects) {
        assert(r.left >= 23 && r.top >= 23 && r.right <= rects.width-23 && r.bottom <= rects.height-23, `Alert outside source bounds: ${width}x${height} ${anchor} ${layout} ${JSON.stringify(r)}`);
      }
      count++;
    }
  }
  alertWindow.destroy(); alertWindow = null;
  return count;
}

app.whenReady().then(async () => {
  console.log('UI QA: creating fixture');
  fixture = await require(join(output,'fixture.cjs')).createFixture(root,dataDir,(channel,value)=>{ if(window&&!window.isDestroyed())window.webContents.send('qa:push:'+channel,value); });
  console.log('UI QA: creating renderer');
  session.defaultSession.webRequest.onBeforeRequest((details, done) => { const allowed=/^(file:|data:|blob:|https?:\/\/127\.0\.0\.1:|ws:\/\/127\.0\.0\.1:)/.test(details.url); done({cancel:!allowed}); });
  ipcMain.handle('qa:invoke', (_,channel,...args)=>fixture.invoke(channel,...args));
  window = new BrowserWindow({ show:false, width:1360, height:900, webPreferences:{ preload:join(__dirname,'ui-test-preload.cjs'), contextIsolation:true, nodeIntegration:false, sandbox:false, offscreen:true, backgroundThrottling:false } });
  console.log('UI QA: loading app');
  window.webContents.on('console-message', (event) => {
    if(event.level==='error'&&!/ERR_BLOCKED_BY_CLIENT/.test(event.message)) { failures.push(event.message); console.error('UI console:',event.message); }
  });
  await window.loadFile(join(root,'out/renderer/index.html'));
  console.log('UI QA: app loaded');
  await until(`!!document.querySelector('.workspace-welcome')`,'empty workspace did not load');
  assert.equal(await js(`document.querySelectorAll('.sidebar .nav-group li').length`),3,'workspace, monitor and connections belong in main navigation');
  assert.equal(await js(`document.querySelectorAll('.content input,.content textarea').length`),0,'empty workspace must not expose settings');
  await capture('workspace-empty');
  const legacy = async (page,sub) => {
    await js(`localStorage.setItem('nav',JSON.stringify({page:${JSON.stringify(page)},sub:${JSON.stringify(sub)}}))`);
    await window.reload(); await until(`!!document.querySelector('.workspace')`,'workspace reload failed'); await delay(150);
  };
  const add = async (id) => {
    await click('Добавить модуль');
    await until(`!!document.querySelector('[data-add-module="${id}"]')`,'catalog module missing: '+id);
    await js(`document.querySelector('[data-add-module="${id}"]').click()`);
    await until(`!!document.querySelector('[data-editor-module="${id}"]')`,'module editor missing: '+id); await until(`!document.querySelector('[data-editor-module="${id}"] [role=status]')`,'module remained suspended: '+id); await delay(150);
  };
  const select = async (id) => { await js(`document.querySelector('[data-module="${id}"]').click()`); await until(`!!document.querySelector('[data-editor-module="${id}"]')`,'selected module missing: '+id); await delay(150); };
  const remove = async () => { await js(`document.querySelector('.workspace-module-menu summary').click()`); await click('Убрать модуль'); await delay(150); };
  await js(`document.querySelector('.search-btn').click()`); await delay(100);
  await fill('.palette-input input','алерты');
  assert.equal(await js(`document.querySelectorAll('.palette-list [role=option]').length`),0,'search exposes uninstalled alert settings or tests');
  await js(`document.querySelector('.palette-backdrop').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
  await legacy('alerts',{});
  assert.equal(await js(`!!document.querySelector('[data-editor-module]')`),false,'old saved alert route bypasses installation');
  assert.equal(await js(`!!document.querySelector('.workspace-required')`),true);
  assert.deepEqual(fixture.settings.get('workspace').cards,[],'navigation must never add a module');
  await capture('workspace-catalog');
  await click('Добавить в область');
  await until(`!!document.querySelector('.alerts-layout iframe')`,'alerts editor missing'); await delay(200);
  await capture('alerts-content');
  await until(`(()=>{const frame=document.querySelector('.alert-preview-col iframe');const box=document.querySelector('.alert-preview-col .scaled-frame');return frame&&box&&parseFloat(frame.style.transform.slice(6))>box.clientWidth/1920*1.5})()`,'close-up preview did not magnify alert text');
  await js(`document.querySelector('[data-alert-control=pause]').click()`); await delay(150);
  assert.equal(fixture.state.current.alerts.paused,true);
  await js(`document.querySelector('[data-alert-control=pause]').click()`); await delay(150);
  assert.equal(fixture.state.current.alerts.paused,false);
  await js(`document.querySelector('.alert-test').click()`); await until(`!document.querySelector('[data-alert-control=skip]').disabled`,'alert test did not start local queue');
  assert.equal(fixture.testBroadcasts.some((message) => message.kind === 'emotes'),false,'alert test triggered emote rain');
  await js(`document.querySelector('[data-alert-control=skip]').click()`); await delay(150);
  assert.equal(fixture.state.current.alerts.current,null);
  const defaultFollowTitle=fixture.settings.get('alerts').types.follow.title;
  await js(`(()=>{const input=document.querySelector('.alert-editor .form .input');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Свежая правка {user}');input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.alert-test').click()})()`);
  await until(`document.querySelector('.workspace-alert-run').textContent.includes('Свежая правка StreamHelper')`,'test used stale configuration before a pending save');
  await js(`document.querySelector('[data-alert-control=skip]').click()`); await delay(150);
  await fill('.alert-editor .form .input',defaultFollowTitle);

  await click('3. Положение');
  await js(`document.querySelector('.alert-position-details').open=true`);
  await js(`document.querySelector('.alert-placement-canvas').scrollIntoView({block:'center'})`); await delay(100);
  const positionCanvas=await js(`(()=>{const r=document.querySelector('.alert-placement-canvas').getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height}})()`);
  const point=(x,y) => ({x:Math.round(positionCanvas.x+positionCanvas.width*x),y:Math.round(positionCanvas.y+positionCanvas.height*y)});
  window.webContents.focus();
  window.webContents.sendInputEvent({type:'mouseMove',...point(.25,.75)}); await delay(50);
  window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point(.25,.75)});
  await delay(50);
  window.webContents.sendInputEvent({type:'mouseMove',modifiers:['leftButtonDown'],...point(.3,.4)});
  await delay(50);
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point(.3,.4)});
  await delay(250);
  assert(Math.abs(fixture.settings.get('alerts').style.x-30)<2,'preview pointer drag did not update x: '+JSON.stringify({canvas:positionCanvas,style:fixture.settings.get('alerts').style}));
  assert(Math.abs(fixture.settings.get('alerts').style.y-40)<2,'preview pointer drag did not update y');
  await js(`document.querySelectorAll('.position-presets button')[8].click()`); await delay(200);
  assert.equal(fixture.settings.get('alerts').style.x,100);
  await capture('alerts-position');
  const writesBefore = fixture.calls.filter(c=>c.channel==='settings:set').length;
  await js(`(()=>{const input=document.querySelectorAll('.alert-editor .input-number')[1];const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;input.focus();for(let n=1;n<=20;n++){setter.call(input,String(n));input.dispatchEvent(new Event('input',{bubbles:true}))}})()`);
  await delay(250);
  assert.equal(fixture.settings.get('alerts').style.x,20);
  assert.equal(fixture.calls.filter(c=>c.channel==='settings:set').length-writesBefore,1,'rapid edits should be coalesced');
  await click('2. Оформление'); await capture('alerts-appearance');
  await click('Панель');
  await until(`!!document.querySelector('.monitor-grid')`,'monitor missing');
  assert.equal(await js(`document.querySelectorAll('.monitor-card').length`),1);
  assert.equal(await js(`document.querySelectorAll('.content input,.content textarea,.content select').length`),0,'monitor exposes configuration');
  await capture('monitor');
  await click('Открыть в области'); await until(`!!document.querySelector('.alerts-layout')`,'monitor did not open installed module');
  await remove();
  assert.deepEqual(fixture.settings.get('workspace').cards,[]);
  assert.equal(fixture.settings.get('alerts').style.x,20,'removing module erased configuration');
  await legacy('overlays',{overlays:'alerts'});
  assert.equal(await js(`!!document.querySelector('[data-editor-module]')`),false,'removed module route exposes editor');
  await click('Добавить в область'); await until(`!!document.querySelector('.alerts-layout')`,'re-added alert missing');
  assert.equal(fixture.settings.get('alerts').style.x,20,'re-adding must restore prior settings');
  await add('song');
  await fill('[data-editor-module="song"] input[placeholder*=youtube]','https://youtu.be/M7lc1UVf-VE');
  await click('Добавить');
  await until(`document.querySelector('[data-editor-module="song"]').textContent.includes('M7lc1UVf-VE')`,'manual song did not enter queue');
  await add('bot'); await click('Таймеры');
  await fill('textarea','Первая фраза. ');
  assert.equal(await js(`document.querySelector('textarea').value`),'Первая фраза. ');
  await fill('textarea','Первая фраза. Вторая фраза. ');
  assert.equal(await js(`document.querySelector('textarea').value`),'Первая фраза. Вторая фраза. ');
  await capture('bot-spaces');
  await add('obs');
  assert.equal(await js(`document.querySelector('[data-editor-module="obs"]').textContent.includes('SubForStream')`),false,'OBS exposes uninstalled captions');
  assert.equal(await js(`document.querySelector('[data-editor-module="obs"]').textContent.includes('Горячие клавиши')`),false,'OBS exposes unrelated action configuration');
  await remove(); assert.equal(fixture.settings.get('obs').port,4455);
  await add('poll');
  assert.equal(await js(`!!document.querySelector('[data-editor-module="poll"] .tabs')`),false,'activity editor exposes sibling tabs');
  assert.equal(fixture.settings.get('workspace').cards.includes('wheel'),false);
  await legacy('interactive',{interactive:'wheel'});
  assert.equal(await js(`!!document.querySelector('[data-editor-module]')`),false,'activity shortcut bypasses installation');
  await click('Отмена');
  await js(`document.querySelector('.profile-current').click()`); await until(`!!document.querySelector('.profile-create')`,'profile dialog missing');
  assert.equal(await js(`document.querySelectorAll('.profile-overlays,.profile-links').length`),0,'profile manager exposes feature settings');
  await fill('.profile-create input','Второй'); await click('Создать копию');
  await until(`!document.querySelector('[role=dialog]')`,'profile switch did not leave stale dialog');
  await select('alerts'); await remove();
  assert.equal(fixture.settings.get('workspace').cards.includes('alerts'),false);
  await js(`document.querySelector('.profile-current').click()`); await until(`!!document.querySelector('.profile-list')`,'profile list missing');
  await js(`document.querySelectorAll('.profile-item')[0].click()`); await until(`!document.querySelector('[role=dialog]')`,'profile activation did not close dialog');
  assert.equal(fixture.settings.get('workspace').cards.includes('alerts'),true,'workspace module choices leaked across profiles');
  assert.equal(await js(`!!document.querySelector('[data-editor-module]')`),false,'profile switch retains a stale editor');
  await js(`document.querySelector('.workspace-preferences').click()`); await until(`!!document.querySelector('[role=dialog]')`,'app preferences missing');
  assert.equal(await js(`document.querySelector('[role=dialog]').textContent.includes('Twitch Client ID')`),false,'app preferences expose uninstalled integration settings');
  await js(`document.querySelector('.workspace-dialog-close button').click()`);
  await select('alerts'); await window.setSize(1000,740); await delay(100); await capture('workspace-small');
  assert.equal(await js(`document.querySelector('.content').scrollWidth>document.querySelector('.content').clientWidth+2`),false,'editor overflows small window');
  await window.setSize(1360,900);
  // Mount every remaining module through the actual catalog, without external service calls.
  await click('Добавить модуль');
  const remaining = await js(`[...document.querySelectorAll('[data-add-module]:not(:disabled)')].map(b=>b.dataset.addModule)`);
  await click('Отмена');
  for (const id of remaining) { await add(id); assert.equal(await js(`document.querySelectorAll('[data-editor-module]').length`),1,'more than one editor mounted'); }
  await click('Рабочая область'); await capture('workspace-modules');
  const tiles = await js(`[...document.querySelectorAll('.workspace-installed')].map((tile)=>tile.getBoundingClientRect().height)`);
  assert(tiles.every((height)=>height<145),'module tiles are too tall');
  await click('Подключения');
  await until(`!!document.querySelector('[data-connection-editor]')`,'connections page missing');
  assert.equal(await js(`document.querySelectorAll('[data-add-module]').length`),0,'connections require installing a workspace module');
  for(const id of ['twitch','donationalerts','streamlabs','streamelements','streamerbot','discord','obs','subforstream']) {
    await js(`document.querySelector('[data-connection="${id}"]').click()`);
    await until(`!!document.querySelector('[data-connection-editor="${id}"]')`,'connection editor missing: '+id);
    assert.equal(await js(`document.querySelectorAll('[data-connection-editor]').length`),1);
  }
  await js(`document.querySelector('[data-connection="twitch"]').click()`); await capture('connections');
  await click('Панель'); await until(`!!document.querySelector('.monitor-grid')`,'full monitor missing'); await capture('monitor-modules');
  assert.equal(await js(`document.querySelectorAll('.monitor-card').length`),30);
  assert.equal(await js(`document.querySelectorAll('.content input,.content textarea,.content select').length`),0,'monitor renders mutable settings');
  await js(`document.querySelector('[data-monitor-edit]').click()`); await delay(150);
  const monitorBefore = await js(`[...document.querySelectorAll('[data-monitor-card]')].map((card)=>card.dataset.monitorCard)`);
  await js(`(()=>{const from=document.querySelector('[data-monitor-card="${monitorBefore[0]}"] .monitor-drag');const to=document.querySelector('[data-monitor-card="${monitorBefore[2]}"]');const data=new DataTransfer();from.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));to.dispatchEvent(new DragEvent('dragover',{bubbles:true,dataTransfer:data}));to.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));from.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:data}))})()`);
  await delay(250);
  assert.equal(fixture.settings.get('workspace').monitor.order[2],monitorBefore[0],'drag did not persist card order');
  await js(`(()=>{const select=document.querySelector('[data-monitor-card="chat"] .monitor-card-options select');select.value='2';select.dispatchEvent(new Event('change',{bubbles:true}))})()`); await delay(250);
  assert.equal(fixture.settings.get('workspace').monitor.sizes.chat.width,2);
  await js(`[...document.querySelectorAll('.monitor-customize .toggle')].find((label)=>label.textContent==='Чат').querySelector('input').click()`); await delay(250);
  assert.equal(await js(`!!document.querySelector('[data-monitor-card="chat"]')`),false);
  assert.equal(fixture.settings.get('workspace').cards.includes('chat'),true);
  await js(`[...document.querySelectorAll('.monitor-customize .toggle')].find((label)=>label.textContent==='Чат').querySelector('input').click()`); await delay(250);
  await capture('monitor-layout');
  await js(`document.querySelector('[data-monitor-edit]').click()`); await window.reload();
  await until(`!!document.querySelector('[data-monitor-card="chat"]')`,'monitor layout reload failed');
  assert.equal(await js(`document.querySelector('[data-monitor-card="chat"]').dataset.width`),'2');
  await click('Рабочая область'); await select('chat');
  await until(`!!document.querySelector('.chat-input input')`,'live chat composer missing from module');
  await fill('.chat-input input','Проверка сообщения'); await click('Отправить');
  await until(`document.querySelector('.workspace-live-chat').textContent.includes('Проверка сообщения')`,'manual chat did not display');
  assert.equal(await js(`document.querySelector('.chat-input input').value`),'');
  assert.equal(await js(`document.querySelectorAll('[data-editor-module="chat"] iframe').length`),0,'live chat mounts unused preview');
  await click('Настроить'); await until(`!!document.querySelector('[data-editor-module="chat"] iframe')`,'chat settings not available inside module');
  assert.equal(await js(`!!document.querySelector('.chat-input')`),false);
  await select('emotes');
  await select('events'); await click('Настроить');
  await until(`!!document.querySelector('[data-editor-module="events"] iframe')`,'events preview missing');
  const broadcastsBefore=fixture.testBroadcasts.length;
  await js(`document.querySelector('[data-editor-module="events"] .ov-preview-actions button:last-child').click()`); await delay(200);
  assert.deepEqual(fixture.testBroadcasts.slice(broadcastsBefore).map((message)=>message.kind),['events'],'events test reached unrelated widgets');
  await click('События');
  assert.equal(await js(`document.querySelector('.workspace-live-events').textContent.includes('StreamHelper')`),true,'isolated event test does not display in feed');
  const originalProfile=fixture.settings.get('activeProfileId');
  const originalWorkspace=structuredClone(fixture.settings.get('workspace'));
  await js(`document.querySelector('.profile-current').click()`); await until(`!!document.querySelector('.profile-create')`,'fresh profile controls missing');
  await fill('.profile-create input','Чистый профиль'); await click('Новый профиль');
  await until(`!!document.querySelector('.workspace-welcome')`,'fresh profile inherited modules');
  assert.deepEqual(fixture.settings.get('workspace').cards,[]);
  assert.equal(fixture.state.current.twitch.account.displayName,'Streamer');
  await js(`document.querySelector('.profile-current').click()`); await until(`!!document.querySelector('.profile-list')`,'fresh profile switch failed');
  await js(`document.querySelectorAll('.profile-item')[0].click()`); await until(`!document.querySelector('[role=dialog]')`,'restore original profile failed');
  assert.equal(fixture.settings.get('activeProfileId'),originalProfile);
  assert.deepEqual(fixture.settings.get('workspace'),originalWorkspace,'fresh profile overwrote existing panel layout');
  await select('alerts');
  await js(`document.querySelector('.workspace-module-menu summary').click();window.confirm=()=>false;void 0`);
  await click('Сбросить настройки модуля');
  assert.equal(fixture.settings.get('alerts').style.x,20,'canceling reset changes configuration');
  const moduleListBeforeReset = [...fixture.settings.get('workspace').cards];
  const songQueueBeforeReset = [...fixture.state.current.songRequests.queue];
  await click('3. Положение');
  await js(`document.querySelector('.alert-position-details').open=true`);
  await js(`(()=>{window.confirm=()=>true;const input=document.querySelectorAll('.alert-editor .input-number')[1];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'12');input.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('.workspace-module-menu button')].find(b=>b.textContent.trim()==='Сбросить настройки модуля').click()})()`); await delay(300);
  assert.equal(fixture.settings.get('alerts').style.x,50,'module reset did not restore defaults');
  assert.deepEqual(fixture.settings.get('workspace').cards,moduleListBeforeReset,'module reset changes installed modules');
  assert.deepEqual(fixture.state.current.songRequests.queue,songQueueBeforeReset,'module reset affects another module');
  await js(`document.querySelector('.workspace-module-menu summary').click()`);
  await js(`document.querySelector('.workspace-preferences').click()`); await until(`!!document.querySelector('[role=dialog] select')`,'language control missing');
  await js(`(()=>{const select=document.querySelector('[role=dialog] select');select.value='en';select.dispatchEvent(new Event('change',{bubbles:true}))})()`); await delay(250);
  await js(`document.querySelector('.workspace-dialog-close button').click()`);
  await click('Workspace'); await capture('workspace-en'); await select('alerts'); await click('3. Position'); await capture('alerts-en');
  assert.equal(await js(`document.documentElement.lang`),'en');
  const alertGeometryCases = await checkAlertBounds();
  assert.deepEqual(failures,[],'renderer console errors');
  writeFileSync(join(output,'ui-results.json'), JSON.stringify({passed:true,alertGeometryCases,moduleEditors:30,connectionEditors:8,checks:['empty workspace','three-page navigation','legacy route gate','search gate','remove/re-add preserves configuration','profile isolation and editor dismissal','individual activity and connection editors','global preferences scope','all 30 module editors','monitor has no feature configuration inputs','manual song queue','safe position settings','close-up live preview','coalesced settings writes','bot trailing spaces','small window layout','real alert DOM geometry','English module workflow','confirmed reset is scoped to current module','reset waits for pending edits','live chat and settings stay in module','local alert queue pause/resume/skip','isolated widget tests with emote rain active','separate connections without installation','fresh profile without losing connections','monitor drag, resize, hide and persistence','compact module tiles','test waits for pending form edits','native pointer drag for alert position'],calls:fixture.calls.map(c=>c.channel)},null,2));
  console.log('UI smoke passed: 30 module editors, 8 connection editors, draggable monitor, fresh profiles and isolated tests. Screenshots: dist/qa');
}).catch((error)=>{console.error(error);process.exitCode=1;}).finally(async()=>{alertWindow?.destroy(); await fixture?.stop(); window?.destroy(); app.exit(process.exitCode||0);});
