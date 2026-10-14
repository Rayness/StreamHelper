// End-to-end check of remote access: the built UI in a browser without the Electron preload,
// talking to the UI fixture through the remote access server only.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { createServer } = require('node:net');
const { join, resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const root = resolve(__dirname, '..');
const output = join(root, 'dist/qa');
const dataDir = join(output, 'remote-run-' + Date.now());
mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir); app.setPath('sessionData', dataDir); app.setPath('crashDumps', join(dataDir, 'crashes'));
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
let window, streamer, h;
const failures = [];
const checks = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (source) => window.webContents.executeJavaScript(source, true);
async function until(source, message) { for (let i = 0; i < 100; i++) { try { if (await js(source)) return; } catch { /* page reloading */ } await delay(50); } throw new Error(message); }
async function capture(name) {
  await delay(150);
  const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  writeFileSync(join(output, name + '.png'), image.toPNG());
}
const ok = (name) => { checks.push(name); console.log('  ✓ ' + name); };

app.whenReady().then(async () => {
  h = await require(join(output, 'remote-fixture.cjs')).createRemoteFixture(root, dataDir);
  // Nothing leaves the machine.
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file:|data:|blob:|devtools:|https?:\/\/127\.0\.0\.1:|wss?:\/\/127\.0\.0\.1:|https?:\/\/localhost:|wss?:\/\/localhost:)/.test(details.url) }));
  window = new BrowserWindow({ show: false, width: 1360, height: 860, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
  window.webContents.on('console-message', (event) => {
    const { level, message } = event;
    if (level === 'error' || level === 3) failures.push(message);
  });

  // Without a key: the sign-in form, not the app.
  await window.loadURL(h.url + '/');
  assert.equal(await js(`!!document.querySelector('form input[name=key]')`), true, 'login form missing');
  await window.loadURL(h.url + '/?key=wrong');
  assert.match(await js(`document.body.innerText`), /не подошёл/, 'wrong key not reported');
  ok('sign-in page without a valid key');

  // Invite link: the full app over the websocket.
  await window.loadURL(h.url + '/?key=qa-key-anna');
  assert.equal(new URL(window.webContents.getURL()).search, '', 'key left in the address bar');
  await until(`!!document.querySelector('.sidebar')`, 'app did not start over remote access');
  assert.match(await js(`document.querySelector('.remote-badge').innerText`), /Анна/, 'moderator badge missing');
  const nav = await js(`[...document.querySelectorAll('.nav-group button')].map(b=>b.innerText.trim())`);
  assert(!nav.some((t) => /Подключения/.test(t)), 'connections visible to a moderator: ' + nav);
  assert(!/Подключения/.test(await js(`document.querySelector('.workspace-rail').innerText`)), 'connections hint shown to a moderator');
  assert.equal(h.clients.at(-1).length, 1, 'session not tracked');
  await capture('remote-moderator');
  ok('app renders from the invite link, key removed from the URL');
  ok('moderator badge shown, connections hidden');

  // Calls: allowed, refused and local-only.
  assert.equal(await js(`window.api.invoke('alerts:pause', true).then(()=> 'ok')`), 'ok');
  assert.equal(h.fixture.calls.at(-1).channel, 'alerts:pause', 'allowed call did not reach the app');
  assert.match(await js(`window.api.invoke('chat:send','hi').then(()=>'sent',e=>e.message)`), /Нет прав/, 'chat allowed without permission');
  assert.match(await js(`window.api.invoke('twitch:login','broadcaster').then(()=>'ok',e=>e.message)`), /Нет прав/, 'login allowed remotely');
  assert.match(await js(`window.api.invoke('settings:set','overlayPort',1).then(()=>'ok',e=>e.message)`), /Нет прав/, 'overlay port writable remotely');
  assert(!h.fixture.calls.some((c) => ['chat:send', 'twitch:login'].includes(c.channel)), 'refused call reached the app');
  ok('allowed call runs, refused calls never reach the app');

  // Live pushes from the streamer side.
  await js(`window.__got=[];window.api.on('settings',(s)=>window.__got.push(s.currency));0`);
  h.fixture.settings.set('currency', 'EUR');
  await until(`window.__got.includes('EUR')`, 'settings push did not reach the moderator');
  ok('settings changes push to the moderator live');

  // A settings section the moderator may edit, through the real form store.
  const pollBefore = h.fixture.settings.get('poll');
  assert.equal(await js(`window.api.invoke('settings:set','poll',${JSON.stringify({ ...pollBefore, durationSec: 77 })}).then(()=>'ok',e=>e.message)`), 'ok');
  assert.equal(h.fixture.settings.get('poll').durationSec, 77, 'allowed settings write lost');
  ok('allowed settings section saves');

  // Preferences: only the moderator's own look; the theme stays in this browser.
  await js(`document.querySelector('.workspace-preferences').click()`);
  await until(`!!document.querySelector('.settings-nav')`, 'preferences missing');
  assert.equal(await js(`document.querySelectorAll('.settings-nav button').length`), 2, 'moderator sees app-wide settings tabs');
  const themeBefore = h.fixture.settings.get('appearance').theme;
  await js(`document.querySelectorAll('.theme-card')[4].click()`); await delay(400);
  assert.equal(await js(`document.documentElement.dataset.theme`), 'light', 'theme not applied for the moderator');
  assert.equal(h.fixture.settings.get('appearance').theme, themeBefore, 'moderator changed the streamer theme');
  await capture('remote-preferences');
  await js(`document.querySelector('.workspace-dialog-close button').click()`);
  ok('preferences limited to look and shortcuts, theme stays local');

  // Overlay previews through the remote server.
  assert.equal(await js(`fetch('/overlay/alerts?preview=1').then(r=>r.status)`), 200, 'overlay preview not proxied');
  assert.equal(await js(`new Promise((res)=>{const w=new WebSocket('ws://'+location.host+'/ws?kind=chat&preview=1');w.onmessage=()=>{w.close();res('msg')};w.onerror=()=>res('error')})`), 'msg', 'overlay websocket not proxied');
  ok('overlay previews and their websocket work remotely');

  // Permission change: the page reloads and the new set applies.
  await js(`window.__marker=1`);
  h.moderators[0].permissions = ['alerts', 'settings', 'chat'];
  h.server.reloadModerator('m1');
  await until(`window.__marker===undefined && !!document.querySelector('.sidebar')`, 'page did not reload after permission change');
  assert.equal(await js(`window.api.invoke('chat:send','hi').then(()=>'sent',e=>e.message)`), 'sent', 'new permission not applied');
  ok('permission change reloads the moderator UI and applies');

  // Streamer disconnects the session.
  await until(`true`, '');
  await delay(200);
  h.server.kick(h.clients.at(-1)[0].id);
  await until(`(document.getElementById('remote-banner')||{}).textContent?.includes('отключил')`, 'kick banner missing');
  const banner = await js(`(()=>{const b=document.getElementById('remote-banner');const r=b.getBoundingClientRect();const top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {w:r.width,h:r.height,top:r.top,onTop:top===b||b.contains(top),parent:b.parentElement.tagName,display:getComputedStyle(b).display}})()`);
  console.log('    banner', JSON.stringify(banner));
  assert(banner.w > 0 && banner.h > 0 && banner.onTop, 'kick banner is not visible: ' + JSON.stringify(banner));
  await capture('remote-kicked');
  ok('kicked session shows a banner and stays down');

  // Moderator removed: back to the sign-in page.
  h.moderators.splice(0, 1);
  await window.loadURL(h.url + '/');
  assert.equal(await js(`!!document.querySelector('form input[name=key]')`), true, 'removed moderator still gets the app');
  ok('removed moderator lands on the sign-in page');

  const relevant = failures.filter((m) => !/Нет прав|no permission|ERR_BLOCKED_BY_CLIENT|favicon/i.test(m));
  assert.deepEqual(relevant, [], 'console errors in the moderator browser');
  ok('no console errors (CSP, scripts) in the moderator browser');
  await streamerFlow();
  assert.deepEqual(failures.filter((m) => !/Нет прав|no permission|ERR_BLOCKED_BY_CLIENT|favicon/i.test(m)), [], 'console errors during the streamer flow');
  writeFileSync(join(output, 'remote-ui-results.json'), JSON.stringify({ passed: true, checks }, null, 2));
  console.log(`Remote UI passed: ${checks.length} checks. Screenshots: dist/qa/remote-*.png`);
}).catch((error) => { console.error(error); console.error('Console errors:', failures); process.exitCode = 1; })
  .finally(async () => { window?.destroy(); streamer?.destroy(); await h?.stop(); app.exit(process.exitCode || 0); });

async function freePort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/** The streamer's own window: the Remote access tab drives the real service, and its link lets a moderator in. */
async function streamerFlow() {
  const sjs = (source) => streamer.webContents.executeJavaScript(source, true);
  async function suntil(source, message) { for (let i = 0; i < 100; i++) { if (await sjs(source)) return; await delay(50); } throw new Error(message); }
  async function sclick(text) {
    await suntil(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(text)})`, 'Button missing: ' + text);
    await sjs(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click();0`); await delay(200);
  }
  const setValue = (selector, value, event = 'input') => sjs(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing '+${JSON.stringify(selector)});el.focus();const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));el.blur();return 0})()`).then(() => delay(200));
  const waitFor = async (pred, message) => { for (let i = 0; i < 100; i++) { if (pred()) return; await delay(50); } throw new Error(message + ': ' + JSON.stringify(remote())); };
  const remote = () => h.fixture.state.current.remote;
  const toggle = `document.querySelector('[role=dialog] .settings-section .card-actions .toggle input').click();0`;

  ipcMain.handle('qa:invoke', (_e, channel, ...args) => h.streamerInvoke(channel, ...args));
  h.onStreamerPush((channel, value) => { if (streamer && !streamer.isDestroyed()) streamer.webContents.send('qa:push:' + channel, value); });
  streamer = new BrowserWindow({ show: false, width: 1360, height: 900, webPreferences: { preload: join(__dirname, 'ui-test-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, offscreen: true, backgroundThrottling: false } });
  streamer.webContents.on('console-message', (event) => { if (event.level === 'error' && !/ERR_BLOCKED_BY_CLIENT/.test(event.message)) failures.push('streamer: ' + event.message); });
  await streamer.loadFile(join(root, 'out/renderer/index.html'));
  await suntil(`!!document.querySelector('.sidebar')`, 'streamer app did not load');
  assert.equal(await sjs(`!!document.querySelector('.remote-badge')`), false, 'streamer sees the moderator badge');
  await sjs(`window.confirm=()=>true;document.querySelector('.workspace-preferences').click();0`);
  await sclick('Удалённый доступ');
  await suntil(`!!document.querySelector('[role=dialog] .remote-help')`, 'remote access tab missing');

  // Turn it on, on a free port.
  const port = await freePort();
  await setValue('[role=dialog] .settings-section .input-number', String(port));
  await sjs(toggle);
  await waitFor(() => remote().status === 'running', 'server did not start');
  assert.equal(remote().port, port, 'chosen port not used');
  await suntil(`document.querySelector('[role=dialog]').innerText.includes('Работает')`, 'running status not shown');
  ok('streamer turns remote access on with a chosen port');

  // Add a moderator, change their permissions.
  await setValue('[role=dialog] .settings-section > .card:nth-child(2) input.input', 'Борис');
  await sclick('Добавить');
  await waitFor(() => remote().moderators.length === 1, 'moderator not added');
  assert.equal(remote().moderators[0].name, 'Борис', 'moderator name');
  assert.deepEqual(remote().moderators[0].permissions, ['chat', 'alerts', 'songs', 'interactive'], 'default permissions');
  await suntil(`!!document.querySelector('.remote-row .chips')`, 'moderator row missing');
  await sclick('OBS');
  await waitFor(() => remote().moderators[0].permissions.includes('obs'), 'permission chip did not save');
  await sclick('Чат');
  await waitFor(() => !remote().moderators[0].permissions.includes('chat'), 'permission chip did not remove');
  assert(!JSON.stringify(remote()).includes(h.secrets.remoteAccess.moderators[0].key), 'key leaked into the state');
  ok('streamer adds a moderator and toggles permissions');

  // Invite link for a custom address.
  await setValue('[role=dialog] .settings-section select', '__custom', 'change');
  await suntil(`!!document.querySelector('[role=dialog] input[placeholder*="trycloudflare"]')`, 'custom address field missing');
  await setValue('[role=dialog] input[placeholder*="trycloudflare"]', `127.0.0.1:${port}`);
  await sclick('Ссылка');
  await waitFor(() => h.links.length > 0, 'link not requested');
  const link = h.links.at(-1);
  assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?key=`), 'invite link: ' + link);
  ok('invite link built for the chosen address');

  // The moderator follows it.
  await window.loadURL(link);
  await until(`!!document.querySelector('.remote-badge')`, 'moderator could not sign in with the invite link');
  assert.match(await js(`document.querySelector('.remote-badge').innerText`), /Борис/);
  assert.match(await js(`window.api.invoke('chat:send','hi').then(()=>'sent',e=>e.message)`), /Нет прав/, 'revoked chat permission still works');
  assert.equal(await js(`window.api.invoke('alerts:pause', false).then(()=>'ok',e=>e.message)`), 'ok');
  await suntil(`document.querySelector('[role=dialog]').innerText.includes('В сети: 1')`, 'online count missing for the streamer');
  await suntil(`[...document.querySelectorAll('.remote-log li')].some(li=>li.innerText.includes('Борис')&&li.innerText.includes('alerts:pause'))`, 'action log missing');
  await capture2('remote-streamer-tab');
  ok('moderator signs in with the link; streamer sees them online and their actions');

  // Permission change from the tab reaches the open moderator page.
  await js(`window.__marker=1`);
  await sclick('Чат');
  await until(`window.__marker===undefined && !!document.querySelector('.remote-badge')`, 'moderator page did not reload');
  assert.equal(await js(`window.api.invoke('chat:send','hi').then(()=>'sent',e=>e.message)`), 'sent', 'granted chat permission not applied');
  ok('permission granted from the tab applies to the open session');

  // Disconnect, new key, delete, turn off.
  await sclick('Отключить');
  await until(`(document.getElementById('remote-banner')||{}).textContent?.includes('отключил')`, 'kick from the tab did not reach the moderator');
  await sclick('Сменить ключ');
  const oldKey = new URL(link).searchParams.get('key');
  assert.notEqual(h.secrets.remoteAccess.moderators[0].key, oldKey, 'key not changed');
  assert.equal((await fetch(link, { redirect: 'manual' })).status, 401, 'old link still works');
  await sclick('Удалить');
  await waitFor(() => remote().moderators.length === 0, 'moderator not removed');
  await sjs(toggle);
  await waitFor(() => remote().status === 'off', 'server did not stop');
  let refused = false;
  try { await fetch(`http://127.0.0.1:${port}/`); } catch { refused = true; }
  assert(refused, 'server still answers after turning off');
  ok('kick, new key, delete and turning off work from the tab');

  async function capture2(name) {
    await delay(200);
    const image = await streamer.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    writeFileSync(join(output, name + '.png'), image.toPNG());
  }
}
