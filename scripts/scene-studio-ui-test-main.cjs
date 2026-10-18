const { app, BrowserWindow, ipcMain, session } = require('electron');
const { join, resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const root = resolve(__dirname, '..');
const output = join(root, 'dist/qa');
const dataDir = join(output, 'studio-run-' + Date.now());
mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir); app.setPath('sessionData', dataDir); app.setPath('crashDumps', join(dataDir, 'crashes'));
app.commandLine.appendSwitch('disable-background-networking'); app.disableHardwareAcceleration();
let window, fixture, liveWindow;
const failures = [], checks = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const js = (source) => window.webContents.executeJavaScript(source, true);
async function until(source, message) { for (let i = 0; i < 100; i++) { if (await js(source)) return; await delay(60); } throw new Error(message); }
async function click(selector) { await until(`!!document.querySelector(${JSON.stringify(selector)})`, 'Missing ' + selector); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await delay(130); }
async function fill(selector, value) {
  await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing '+${JSON.stringify(selector)});el.focus();const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await delay(90);
}
async function select(selector, value) { await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}))})()`); await delay(180); }
async function action(name) { await click(`[data-studio-action="${name}"]`); }
async function tab(name) { await click(`[data-studio-tab="${name}"]`); }
async function openStudio() {
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Студия событий'||b.textContent.trim()==='Event Scene Studio')`, 'Scene Studio navigation missing');
  await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Студия событий'||b.textContent.trim()==='Event Scene Studio').click()`);
  await until(`!!document.querySelector('[data-event-studio]')`, 'Scene Studio page missing');
}
async function ready() { await until(`document.querySelector('[data-studio-runtime]')?.dataset.studioRuntime==='ready'`, 'Scene runtime never became ready'); }
async function frameValue(source) {
  const frame = window.webContents.mainFrame.frames.find((frame) => frame.url.includes('/overlay/assets/scene-frame.html'));
  assert(frame, 'Isolated scene frame missing');
  return frame.executeJavaScript(source);
}
async function capture(name) {
  await delay(120);
  const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  assert(image.getSize().width > 0, 'Empty screenshot');
  writeFileSync(join(output, name + '.png'), image.toPNG());
}
async function flush() { await delay(400); }
const studio = () => fixture.settings.get('alerts').studio;

app.whenReady().then(async () => {
  fixture = await require(join(output, 'fixture.cjs')).createFixture(root, dataDir, (channel, value) => { if (window && !window.isDestroyed()) window.webContents.send('qa:push:' + channel, value); });
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file:|data:|blob:|https?:\/\/127\.0\.0\.1:|ws:\/\/127\.0\.0\.1:|https?:\/\/localhost:|ws:\/\/localhost:)/.test(details.url) }));
  ipcMain.handle('qa:invoke', (_, channel, ...args) => fixture.invoke(channel, ...args));
  window = new BrowserWindow({ show: false, width: 1520, height: 1000, webPreferences: { preload: join(__dirname, 'ui-test-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, offscreen: true, backgroundThrottling: false } });
  window.webContents.on('console-message', (event) => { if (event.level === 'error' && !/ERR_BLOCKED_BY_CLIENT|QA deliberate runtime/.test(event.message)) failures.push(event.message); });
  await window.loadFile(join(root, 'out/renderer/index.html'));
  await openStudio();
  await js(`void(window.confirm=()=>true)`);
  assert.equal(studio()?.scenes.length ?? 0, 0);
  await click('[data-studio-preset="0"]');
  await tab('settings');
  await fill('[data-studio-field="name"]', 'QA donation');
  await fill('[data-studio-params]', '{"accent":null}');
  assert.equal(await js(`document.querySelector('[data-studio-action="publish"]').disabled`), true, 'Invalid custom parameters enabled publication');
  await fill('[data-studio-params]', '{"image":"qa-image.png","sound":"qa-sound.wav"}');
  await select('.media-picker select', '');
  await js(`(()=>{const el=document.querySelectorAll('.media-picker select')[1];el.value='';el.dispatchEvent(new Event('change',{bubbles:true}))})()`); await delay(100);
  assert.equal(await js(`JSON.parse(document.querySelector('[data-studio-params]').value).image`), '');
  assert.equal(await js(`JSON.parse(document.querySelector('[data-studio-params]').value).sound`), '');
  await fill('[data-studio-params]', '{"accent":"#62e6c0","count":7,"enabled":true}');
  await fill('[data-studio-sample="user"]', 'QA viewer');
  await fill('[data-studio-sample="message"]', '<script>window.pwned=true</script>');
  await tab('html');
  const html = '<main><h1 data-field="user"></h1><p data-field="message"></p><b id="custom"></b></main>';
  await fill('[data-studio-code="html"]', html);
  await tab('js');
  await fill('[data-studio-code="js"]', 'document.getElementById("custom").textContent=String(scene.params.count);');
  await action('restart'); await ready();
  assert.equal(await frameValue('document.querySelector("h1").textContent'), 'QA viewer');
  assert.equal(await frameValue('document.querySelector("#custom").textContent'), '7');
  assert.equal(await frameValue('window.pwned === undefined'), true, 'Event text executed as HTML');
  assert.equal(await frameValue('window.api === undefined && typeof require === "undefined"'), true, 'Scene has application privileges');
  checks.push('author code/custom params/sample events run in isolated frame; viewer text remains text');
  await capture('scene-studio-editor');

  await fill('[data-studio-code="js"]', 'throw new Error("QA deliberate runtime");');
  await action('restart');
  await until(`document.querySelector('[data-studio-runtime-error]')?.textContent.includes('QA deliberate runtime')`, 'Runtime error missing from editor');
  await fill('[data-studio-code="js"]', 'document.getElementById("custom").textContent=String(scene.params.count);');
  await action('restart'); await ready();
  assert.equal(await js(`!!document.querySelector('[data-studio-runtime-error]')`), false);
  checks.push('script errors visible and restart recovers');

  await action('save'); await flush();
  assert.equal(studio().scenes.length, 1); assert.equal(studio().scenes[0].published, false);
  const donationId = studio().scenes[0].id;
  await tab('bindings');
  assert.equal(await js(`document.querySelector('[data-studio-binding="donation"]').options.length`), 1, 'Unpublished scene exposed to live binding');
  await action('publish'); await flush();
  assert.equal(studio().scenes[0].published, true);
  await select('[data-studio-binding="donation"]', donationId);
  await action('add-level'); await flush();
  assert.equal(studio().donationLevels[0].sceneId, donationId);
  assert.match(await js(`document.querySelector('[data-studio-donation-match]').textContent`), /QA donation/);
  await action('add-level'); await flush();
  await fill(`[data-studio-level="${studio().donationLevels[1].id}"] .input-number`, '5000');
  await fill('.studio-sample .input-number', '5000');
  assert.match(await js(`document.querySelector('[data-studio-donation-match]').textContent`), /≥ 5000/, 'Highest applicable donation level not chosen');
  await fill('.studio-sample .input-number', '1000');
  assert.match(await js(`document.querySelector('[data-studio-donation-match]').textContent`), /≥ 1000/, 'Exact lower donation threshold not chosen');
  await click('.studio-topbar .toggle input'); await flush(); assert.equal(studio().enabled, true);
  checks.push('save draft excludes live bindings; publish/binding/master and donation threshold persist');

  await tab('html');
  await fill('[data-studio-code="html"]', html + '<i>revision</i>');
  await js(`void(window.confirm=()=>false)`);
  await click('[data-studio-preset="3"]');
  assert.equal(await js(`document.querySelector('[data-studio-code="html"]').value`), html + '<i>revision</i>', 'Scene switch ignored unsaved-edit cancellation');
  await js(`[...document.querySelectorAll('.sidebar button')].find(button=>button.textContent.trim()==='Рабочая область').click()`);
  assert.equal(await js(`!!document.querySelector('[data-event-studio]')`), true, 'Navigation ignored unsaved-edit cancellation');
  await js(`void(window.confirm=()=>true)`);
  await action('save'); await flush();
  const revision = studio().scenes.find((scene) => !scene.published);
  assert(revision && revision.draftOf === donationId);
  assert.equal(studio().scenes.find((scene) => scene.id === donationId).html, html, 'Save draft modified live scene');
  await action('publish'); await flush();
  assert.equal(studio().scenes.length, 1); assert.equal(studio().scenes[0].id, donationId);
  assert.match(studio().scenes[0].html, /revision/);
  assert.equal(studio().bindings.donation, donationId, 'Publish lost event binding');
  checks.push('editing published scene creates separate saved draft; publish updates original without losing binding');

  // An external profile activation cannot be blocked by renderer navigation guards.
  // Keep the edit in profile-scoped recovery, and prove it survives a full reload.
  const originalProfile = fixture.settings.all.activeProfileId;
  await fill('[data-studio-code="html"]', html + '<i>unsaved recovery</i>');
  await fixture.invoke('profiles:create', 'QA second profile', 'empty'); await flush();
  const secondProfile = fixture.settings.all.activeProfileId;
  assert.notEqual(originalProfile, secondProfile);
  assert.equal(studio().scenes.length, 0);
  await fixture.invoke('profiles:activate', originalProfile); await flush();
  await until(`document.querySelector('[data-studio-code="html"]')?.value.includes('unsaved recovery')`, 'Working copy lost after profile return');
  window.webContents.once('will-prevent-unload', (event) => event.preventDefault());
  await window.reload(); await openStudio(); await js(`void(window.confirm=()=>true)`); await tab('html');
  assert.equal(await js(`document.querySelector('[data-studio-code="html"]').value`), html + '<i>unsaved recovery</i>', 'Unsaved recovery lost on reload');
  // Saving also proves restored content retains its original live/draft relationship.
  await action('save'); await flush();
  assert.equal(studio().scenes.filter((scene) => !scene.published).length, 1);
  await window.reload(); await openStudio(); await js(`void(window.confirm=()=>true)`);
  assert.equal(studio().bindings.donation, donationId);
  checks.push('profiles isolate scene settings and recover pending edits; drafts and bindings survive reload');

  await click('[data-studio-preset="2"]'); await action('restart'); await ready();
  assert.equal(await frameValue('scene.event.type'), 'giftsub');
  assert.equal(await frameValue('document.querySelectorAll(".gift").length'), 5);
  await delay(1000); await capture('scene-studio-gifts');
  assert.equal(await frameValue(`(()=>{const rect=document.querySelector('main').getBoundingClientRect();return Math.abs(rect.x+rect.width/2-innerWidth/2)<2&&Math.abs(rect.y+rect.height/2-innerHeight/2)<2})()`), true, 'Gift preset body layout did not center the scene');
  await action('save'); await flush();
  await click('[data-studio-preset="3"]'); await action('restart'); await ready();
  assert.equal(await frameValue('scene.event.type'), 'raid');
  assert.equal(await frameValue('document.querySelectorAll(".ship").length'), 42);
  await delay(700); await capture('scene-studio-raid');
  assert.equal(await frameValue(`(()=>{const rect=document.querySelector('main').getBoundingClientRect();return Math.abs(rect.x+rect.width/2-innerWidth/2)<2&&Math.abs(rect.y+rect.height/2-innerHeight/2)<2})()`), true, 'Raid preset body layout did not center the scene');
  await action('save'); await flush();
  checks.push('gift batch and raid presets consume count/viewers sample fields');

  await tab('ai');
  await until(`!!document.querySelector('[data-studio-api-key]')`, 'AI config missing');
  await fill('[data-studio-ai-model]', 'qa-fixture-model');
  await fill('[data-studio-api-key]', 'qa-fake-secret');
  await action('save-ai');
  assert.equal(await js(`document.querySelector('[data-studio-api-key]').value`), '', 'API key not cleared after configuration');
  assert(fixture.calls.some((call) => call.channel === 'scene:ai:configure' && call.args[1] === 'qa-fake-secret'));
  const beforeAi = JSON.stringify(studio().scenes);
  await fill('[data-studio-ai-prompt]', 'QA fake generation only');
  await action('generate');
  await until(`!!document.querySelector('[data-studio-action="apply-ai"]')`, 'Generated scene was not offered for review');
  assert.equal(JSON.stringify(studio().scenes), beforeAi);
  await action('apply-ai');
  assert.equal(await js(`document.querySelector('[data-studio-dirty]').dataset.studioDirty`), 'true');
  assert.equal(JSON.stringify(studio().scenes), beforeAi, 'AI implicitly saved or published scene');
  assert(await js(`!!document.querySelector('[data-studio-mcp-status]')`));
  assert(await js(`[...document.querySelectorAll('.copy-field input')].some(input=>input.value.includes('mcpServers')&&input.value.includes('Authorization'))`));
  await click('.studio-mcp-card .toggle input');
  await until(`document.querySelector('[data-studio-mcp-status]').textContent==='Работает'`, 'MCP server did not start from UI');
  assert(fixture.calls.some((call) => call.channel === 'scene:mcp:configure' && call.args[0] === true));
  const connectionBeforeRotate = await js(`[...document.querySelectorAll('.copy-field input')].find(input=>input.value.includes('mcpServers')).value`);
  await js(`[...document.querySelectorAll('.studio-mcp-card button')].find(button=>button.textContent.trim()==='Обновить токен').click()`); await flush();
  assert(fixture.calls.some((call) => call.channel === 'scene:mcp:rotate'));
  assert.notEqual(await js(`[...document.querySelectorAll('.copy-field input')].find(input=>input.value.includes('mcpServers')).value`), connectionBeforeRotate, 'MCP rotation did not update the connection token');
  checks.push('fake AI config clears secret; generated candidate requires review and explicit persistence; MCP connection config visible');
  await capture('scene-studio-ai-mcp');
  await action('save'); await flush();
  await window.setSize(1000, 760); await js(`document.querySelector('.content').scrollTop=0`); await delay(150);
  assert.equal(await js(`document.querySelector('.content').scrollWidth>document.querySelector('.content').clientWidth+2`), false, 'Studio overflows narrow desktop window');
  await capture('scene-studio-small');
  checks.push('narrow desktop layout has no horizontal page overflow');
  assert.deepEqual(fixture.testBroadcasts, [], 'Studio preview emitted live overlay tests');
  // Exercise the actual live source separately from editor preview, with an isolated
  // local queue and no OBS process, accounts, external APIs or main-app preload.
  liveWindow = new BrowserWindow({ show: false, width: 960, height: 540, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  await liveWindow.loadURL(fixture.state.current.overlayUrl + '/overlay/alerts');
  for (let i = 0; i < 80 && !fixture.state.current.overlayKinds.alerts; i++) await delay(50);
  assert(fixture.state.current.overlayKinds.alerts, 'Live local overlay did not connect');
  const liveScene = studio().scenes.find((scene) => scene.id === donationId);
  const liveEvent = { id: 'qa-live-scene', type: 'donation', user: 'QA live user', amount: 7890, currency: 'RUB', message: 'Live local overlay QA', count: 17, viewers: 73, months: 9, tier: '2000', anonymous: false, source: 'test' };
  await fixture.invoke('scene:test', liveScene, liveEvent);
  let liveFrame;
  for (let i = 0; i < 100; i++) {
    liveFrame = liveWindow.webContents.mainFrame.frames.find((frame) => frame.url.includes('/overlay/assets/scene-frame.html'));
    if (liveFrame && await liveFrame.executeJavaScript('!!window.scene').catch(() => false)) break;
    await delay(50);
  }
  assert(liveFrame && await liveFrame.executeJavaScript('!!window.scene'), 'Live source did not execute scene document');
  assert.deepEqual(await liveFrame.executeJavaScript('({user:scene.event.user,count:scene.event.count,viewers:scene.event.viewers,amount:scene.event.amount,preview:scene.preview,privileged:!!window.api})'), { user: 'QA live user', count: 17, viewers: 73, amount: 7890, preview: false, privileged: false });
  const bounds = await liveWindow.webContents.executeJavaScript(`(()=>{const frame=document.querySelector('#stage iframe');const rect=frame.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,nativeWidth:frame.style.width,nativeHeight:frame.style.height}})()`);
  assert.equal(bounds.nativeWidth, liveScene.width + 'px'); assert.equal(bounds.nativeHeight, liveScene.height + 'px');
  assert(bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= 961 && bounds.y + bounds.height <= 541, 'Live scene outside overlay viewport: ' + JSON.stringify(bounds));
  const liveImage = await liveWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  writeFileSync(join(output, 'scene-studio-live-overlay.png'), liveImage.toPNG());
  await fixture.invoke('alerts:skip'); await delay(120);
  assert.equal(await liveWindow.webContents.executeJavaScript('!!document.querySelector("#stage iframe")'), false, 'Skipping did not remove live scene frame');
  checks.push('actual live alerts source executes sandbox scene with event payload, scales to viewport, and removes frame on skip');
  assert.deepEqual(failures, [], 'Unexpected renderer console errors');
  writeFileSync(join(output, 'scene-studio-ui-results.json'), JSON.stringify({ passed: true, checks, calls: fixture.calls.map((call) => call.channel) }, null, 2));
  console.log('Scene Studio isolated UI QA passed: ' + checks.length + ' workflows. Screenshots: dist/qa/scene-studio-*.png');
}).catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { liveWindow?.destroy(); await fixture?.stop(); window?.destroy(); app.exit(process.exitCode || 0); });
