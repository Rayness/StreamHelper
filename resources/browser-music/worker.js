const ALARM = 'streamhelper-music';

function pairingDetails(link) {
  const url = new URL(link);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/music/browser' ||
      url.username || url.password || url.search || !/^#[a-f0-9]{64}$/i.test(url.hash)) throw new Error('invalid');
  const token = url.hash.slice(1);
  url.hash = '';
  return { endpoint: url.href, token };
}

async function audibleTabs() {
  const tabs = await chrome.tabs.query({ audible: true });
  return tabs.flatMap((tab) => {
    if (tab.incognito || tab.mutedInfo?.muted || !tab.url || !tab.title) return [];
    const url = new URL(tab.url);
    if (!['http:', 'https:'].includes(url.protocol)) return [];
    return [{ host: url.hostname, title: tab.title.slice(0, 250) }];
  }).slice(0, 12);
}

async function send(connection, tabs) {
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(2500),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
    body: JSON.stringify({ client: connection.client, tabs }),
  });
  if (response.status !== 204) throw new Error('connection');
}

async function report() {
  const { connection } = await chrome.storage.local.get('connection');
  if (connection) await send(connection, await audibleTabs());
}

let pending;
let work = Promise.resolve();
function enqueue(task) {
  const result = work.then(task);
  work = result.catch(() => {});
  return result;
}

function queueReport() {
  clearTimeout(pending);
  pending = setTimeout(() => void enqueue(report), 200);
}

chrome.tabs.onUpdated.addListener((_id, changes, tab) => {
  if ('audible' in changes || 'mutedInfo' in changes || (tab.audible && ('url' in changes || 'title' in changes))) queueReport();
});
chrome.tabs.onRemoved.addListener(queueReport);
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) queueReport(); });

async function changeConnection(message) {
  if (message.type === 'disconnect') {
    const { connection } = await chrome.storage.local.get('connection');
    await chrome.storage.local.remove('connection');
    await chrome.alarms.clear(ALARM);
    if (connection) await send(connection, null).catch(() => {});
    return;
  }
  let details;
  try { details = pairingDetails(message.link); }
  catch { throw new Error('invalid'); }
  const { connection: previous } = await chrome.storage.local.get('connection');
  const connection = { ...details, client: previous?.client ?? crypto.randomUUID() };
  await send(connection, await audibleTabs());
  await chrome.storage.local.set({ connection });
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== 'connect' && message?.type !== 'disconnect') return;
  enqueue(() => changeConnection(message)).then(() => respond({ ok: true }), (error) => respond({ error: error.message === 'invalid' ? 'invalid' : 'connection' }));
  return true;
});

async function restore() {
  const { connection } = await chrome.storage.local.get('connection');
  if (!connection) return;
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  queueReport();
}
chrome.runtime.onStartup.addListener(() => void restore());
chrome.runtime.onInstalled.addListener(() => void restore());
