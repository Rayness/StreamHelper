const ru = chrome.i18n.getUILanguage().startsWith('ru');
const text = ru ? {
  hint: 'Вставьте ссылку из «Оверлеи → Сейчас играет → Определение вкладки».',
  connect: 'Подключить', disconnect: 'Отключить', connected: 'Привязка сохранена.',
  invalid: 'Скопируйте ссылку подключения из StreamHelper.', connection: 'Проверьте, что StreamHelper запущен, и скопируйте актуальную ссылку.',
} : {
  hint: 'Paste the link from Overlays → Now playing → Identify browser tabs.',
  connect: 'Connect', disconnect: 'Disconnect', connected: 'Paired with StreamHelper.',
  invalid: 'Copy the pairing link from StreamHelper.', connection: 'Make sure StreamHelper is running and copy the current pairing link.',
};
document.documentElement.lang = ru ? 'ru' : 'en';
const link = document.querySelector('#link');
const form = document.querySelector('form');
const status = document.querySelector('#status');
const connect = document.querySelector('#connect');
const disconnect = document.querySelector('#disconnect');
document.querySelector('#hint').textContent = text.hint;
connect.textContent = text.connect;
disconnect.textContent = text.disconnect;

function setPaired(paired) {
  form.hidden = paired;
  disconnect.hidden = !paired;
  status.textContent = paired ? text.connected : '';
}

chrome.storage.local.get('connection').then(({ connection }) => setPaired(!!connection));
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  connect.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'connect', link: link.value.trim() });
    if (result.ok) { link.value = ''; setPaired(true); }
    else status.textContent = text[result.error];
  } catch { status.textContent = text.connection; }
  finally { connect.disabled = false; }
});
disconnect.addEventListener('click', async () => {
  disconnect.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'disconnect' });
    if (result.ok) setPaired(false);
    else status.textContent = text[result.error];
  } catch { status.textContent = text.connection; }
  finally { disconnect.disabled = false; }
});
