import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, shell, Tray } from 'electron';
import type { AlertType, IpcPush, Language, MediaFile } from '@shared/types';
import { BotService } from './bot/bot';
import type { AppContext } from './core/context';
import { EventBus } from './core/eventBus';
import { UpdateService } from './core/updater';
import { SecretStore } from './core/secrets';
import { StateHub } from './core/state';
import { SettingsStore } from './core/store';
import { DonationAlertsService } from './donations/donationalerts';
import { StreamlabsService } from './donations/streamlabs';
import { ActionRunner } from './features/actions';
import { AlertQueue, sampleEvent } from './features/alerts';
import { TextOverlays } from './features/banners';
import { AdsService } from './features/ads';
import { BossService } from './features/boss';
import { ChatHistory, sampleChatMessage } from './features/chatHistory';
import { EmoteRain } from './features/emotes';
import { GiveawayService } from './features/giveaway';
import { PollService } from './features/poll';
import { ProgressTracker } from './features/progress';
import { QuizService } from './features/quiz';
import { SpotlightService } from './features/spotlight';
import type { StageDeps } from './features/stage';
import { WheelService } from './features/wheel';
import { KawakiService } from './integrations/kawaki/service';
import { push, registerIpc } from './ipc';
import { ObsService } from './obs/obs';
import { createAuthRoutes } from './overlay/authPages';
import { createDockRoutes } from './overlay/dock';
import { OverlayHub } from './overlay/hub';
import { OverlayServer } from './overlay/server';
import { TwitchService } from './platforms/twitch/service';
import { PlatformRegistry } from './platforms/types';

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
const AUDIO_EXT = ['.mp3', '.ogg', '.wav', '.m4a'];
const VIDEO_EXT = ['.webm', '.mp4'];

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(bootstrap).catch((err) => {
    console.error('[main] failed to start', err);
    dialog.showErrorBox('StreamHelper', String(err?.stack ?? err));
    app.exit(1);
  });
}

function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');
}

function iconImage(): Electron.NativeImage {
  const file = join(resourcesDir(), 'icon.png');
  return existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
}

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('app.streamhelper');
  const userData = app.getPath('userData');
  const mediaDir = join(userData, 'media');
  mkdirSync(mediaDir, { recursive: true });

  const bus = new EventBus();
  const systemLang: Language = app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en';
  const settings = new SettingsStore(join(userData, 'settings.json'), bus, systemLang);
  const secrets = new SecretStore(join(userData, 'secrets.bin'));
  const state = new StateHub(bus);
  let dockToken = secrets.get('dockToken');
  if (!dockToken) {
    dockToken = randomBytes(32).toString('hex');
    secrets.set('dockToken', dockToken);
  }

  const ctx: AppContext = {
    bus,
    settings,
    secrets,
    state,
    mediaDir,
    toast: (kind, key, params) => push('toast', { kind, key, params } satisfies IpcPush['toast']),
    openExternal: (url) => void shell.openExternal(url),
  };

  // ---------- services ----------
  const chatHistory = new ChatHistory(bus);
  const platforms = new PlatformRegistry();
  const twitch = new TwitchService(ctx);
  platforms.register(twitch);
  const obs = new ObsService(ctx);
  const streamlabs = new StreamlabsService(ctx);
  const progress = new ProgressTracker(ctx);
  const updater = new UpdateService(ctx);

  let overlay!: OverlayServer;
  const donationalerts = new DonationAlertsService(ctx, () => `http://127.0.0.1:${overlay.port}/auth/donationalerts`);
  const alerts = new AlertQueue(
    ctx,
    (alert) => overlay.broadcast('alerts', { type: 'alert', alert }),
    () => overlay.broadcast('alerts', { type: 'alertSkip' }),
  );
  let hub!: OverlayHub;
  let dockRoute!: ReturnType<typeof createDockRoutes>;
  const authRoute = createAuthRoutes((token, expiresIn) => donationalerts.completeLogin(token, expiresIn));
  overlay = new OverlayServer({
    port: settings.get('overlayPort'),
    overlaysDir: join(resourcesDir(), 'overlays'),
    mediaDir,
    initialMessages: (kind, id) => hub.initialMessages(kind, id),
    onClientsChanged: (count, perKind) => {
      state.patch('overlayClients', count);
      state.replace('overlayKinds', perKind);
    },
    extraRoute: async (req, res, url) => (await authRoute(req, res, url)) || dockRoute(req, res, url),
  });

  const sendToAllChats = async (text: string) => {
    const ready = platforms.ready();
    if (!ready.length) throw new Error('chat is not connected');
    await Promise.all(ready.map((p) => p.sendMessage(text)));
  };
  const stage: StageDeps = {
    broadcast: (kind, msg, id) => overlay.broadcast(kind, msg, id),
    say: (text) => sendToAllChats(text).catch((err) => console.warn('[stage] chat', String(err?.message ?? err))),
  };
  const kawaki = new KawakiService(ctx, {
    updateTitle: (title) => twitch.updateStream({ title }),
    canUpdateTitle: () => state.current.twitch.status === 'connected',
  });
  const wheel = new WheelService(ctx, stage);
  const poll = new PollService(ctx, stage);
  const giveaway = new GiveawayService(ctx, stage);
  const quiz = new QuizService(ctx, stage, kawaki);
  const boss = new BossService(ctx, stage);
  const ads = new AdsService(ctx, stage);
  const spotlight = new SpotlightService(ctx, stage, chatHistory);
  const emotes = new EmoteRain(ctx, stage);
  const text = new TextOverlays(ctx, () => overlay);
  hub = new OverlayHub(ctx, overlay, chatHistory, {
    alerts: () => alerts,
    text: () => text,
    poll: () => poll.overlayMessage(),
    giveaway: () => giveaway.overlayMessage(),
    quiz: () => quiz.overlayMessage(),
    boss: () => boss.overlayMessage(),
    ad: (id) => ads.overlayMessage(id),
    spotlight: () => spotlight.overlayMessage(),
  });

  const bot = new BotService(ctx, platforms, twitch);
  const actions = new ActionRunner(ctx, {
    obsScene: (s) => obs.setScene(s),
    obsToggleSource: (scene, source) => obs.toggleSourceByName(scene, source),
    obsToggleMute: (i) => obs.toggleMute(i),
    obsStream: (m) => obs.stream(m),
    obsRecord: (m) => obs.record(m),
    chat: sendToAllChats,
    alertsTogglePause: () => alerts.togglePause(),
    alertsSkip: () => alerts.skip(),
    counter: (name, delta) => void bot.addCounter(name, delta),
    timerToggle: (id) => progress.toggleTimer(id),
    timerAdd: (id, sec) => progress.controlTimer(id, 'add', sec),
    goalAdd: (id, amount) => progress.addToGoal(id, amount),
    wheelSpin: (id) => wheel.spin(id),
    bannerToggle: (id) => text.toggle(id),
    emoteBurst: () => emotes.burst(),
  });
  dockRoute = createDockRoutes({
    token: dockToken,
    htmlPath: join(resourcesDir(), 'overlays', 'dock.html'),
    snapshot: () => ({ state: state.current, settings: settings.all }),
    action: async (name, id) => {
      switch (name) {
        case 'stream': return obs.stream('toggle');
        case 'record': return obs.record('toggle');
        case 'scene': if (id) return obs.setScene(id); break;
        case 'alertsPause': return alerts.togglePause();
        case 'alertsSkip': return alerts.skip();
        case 'pollStart': return poll.start();
        case 'pollEnd': return poll.end();
        case 'giveawayOpen': return giveaway.open();
        case 'giveawayRoll': return giveaway.roll();
        case 'bossStart': return boss.start();
        case 'bossHit': return void boss.hit();
        case 'adShow': if (id) return ads.show(id); break;
        case 'adHide': return ads.hide();
        case 'quickAction': if (id) return actions.run(id); break;
        case 'spotlightClear': return spotlight.clear();
      }
      throw new Error('Unknown dock action');
    },
  });

  // ---------- UI sync ----------
  let stateTimer: NodeJS.Timeout | null = null;
  bus.on('state:dirty', () => {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      push('state', state.current);
    }, 50);
  });
  let settingsTimer: NodeJS.Timeout | null = null;
  bus.on('settings:changed', (key) => {
    if (key === 'overlayPort') void startOverlay(true);
    if (key === 'language') createTray();
    if (settingsTimer) return;
    settingsTimer = setTimeout(() => {
      settingsTimer = null;
      push('settings', settings.all);
    }, 50);
  });
  bus.on('chat:message', (m) => push('chat:message', m));
  bus.on('chat:delete', (p) => push('chat:delete', p));
  bus.on('chat:clearUser', (p) => push('chat:clearUser', p));
  bus.on('chat:clear', () => push('chat:clear', {}));
  bus.on('event', (e) => push('event', e));

  async function startOverlay(restart = false): Promise<void> {
    const port = settings.get('overlayPort');
    try {
      if (restart) await overlay.restart(port);
      else await overlay.start();
      state.patch('overlayUrl', `http://127.0.0.1:${port}`);
      state.patch('dockUrl', `http://127.0.0.1:${port}/dock?token=${dockToken}`);
    } catch (err) {
      console.error('[overlay] cannot listen', err);
      state.patch('overlayUrl', '');
      state.patch('dockUrl', '');
      ctx.toast('error', 'toast.overlayPortBusy', { port });
    }
  }

  // ---------- IPC ----------
  const listMedia = (): MediaFile[] =>
    readdirSync(mediaDir)
      .filter((f) => [...IMAGE_EXT, ...AUDIO_EXT, ...VIDEO_EXT].includes(extname(f).toLowerCase()))
      .map((name) => mediaInfo(name, overlay.port));

  registerIpc({
    'app:init': () => ({
      settings: settings.all,
      state: state.current,
      chat: chatHistory.recent(),
      events: alerts.recentEvents,
      version: app.getVersion(),
    }),
    'settings:set': (key, value) => settings.set(key, value),
    'settings:reset': (key) => {
      settings.reset(key);
      return settings.all;
    },
    'twitch:login': (acc) => void twitch.login(acc),
    'twitch:logout': (acc) => twitch.logout(acc),
    'twitch:cancelLogin': (acc) => twitch.cancelLogin(acc),
    'twitch:updateStream': (patch) => twitch.updateStream(patch),
    'twitch:searchCategories': (q) => twitch.searchCategories(q),
    'chat:send': async (text, replyTo) => {
      const p = platforms.get('twitch');
      if (!p?.isChatReady()) throw new Error('chat is not connected');
      await p.sendMessage(text, replyTo, { asBroadcaster: true });
    },
    'chat:delete': (id) => twitch.deleteMessage(id),
    'chat:timeout': (userId, sec) => twitch.timeout(userId, sec),
    'chat:ban': (userId) => twitch.ban(userId),
    'chat:test': () => bus.emit('chat:message', sampleChatMessage(settings.get('language'))),
    'da:login': () => donationalerts.login(),
    'da:logout': () => donationalerts.logout(),
    'streamlabs:connect': (token) => streamlabs.connect(token),
    'streamlabs:disconnect': () => streamlabs.disconnect(),
    'obs:connect': (password) => obs.connect(password),
    'obs:disconnect': () => obs.disconnect(),
    'obs:setScene': (s) => obs.setScene(s),
    'obs:toggleSource': (scene, id) => obs.toggleSceneItem(scene, id),
    'obs:toggleMute': (input) => obs.toggleMute(input),
    'obs:stream': (m) => obs.stream(m),
    'obs:record': (m) => obs.record(m),
    'alerts:test': (type: AlertType) => bus.emit('event', sampleEvent(type, settings.get('language'), settings.get('currency'))),
    'alerts:pause': (paused) => alerts.setPaused(paused),
    'alerts:skip': () => alerts.skip(),
    'alerts:replay': (id) => alerts.replay(id),
    'actions:run': (id) => actions.run(id),
    'timer:control': (id, op, sec) => progress.controlTimer(id, op, sec),
    'banner:showNow': (id) => text.showNow(id),
    'stats:reset': () => progress.resetStats(),
    'emotes:test': () => emotes.burst(),
    'wheel:spin': (id) => wheel.spin(id, state.current.twitch.account?.displayName ?? ''),
    'poll:start': () => poll.start(),
    'poll:end': () => poll.end(),
    'poll:clear': () => poll.clear(),
    'giveaway:open': () => giveaway.open(),
    'giveaway:close': () => giveaway.close(),
    'giveaway:roll': () => giveaway.roll(),
    'giveaway:reset': () => giveaway.reset(),
    'quiz:start': () => quiz.start(),
    'quiz:skip': () => quiz.skip(),
    'quiz:stop': () => quiz.stop(),
    'boss:start': () => boss.start(),
    'boss:reset': () => boss.reset(),
    'boss:hit': () => void boss.hit(),
    'ad:show': (id) => ads.show(id),
    'ad:hide': () => ads.hide(),
    'spotlight:show': (id) => spotlight.show(id),
    'spotlight:clear': () => spotlight.clear(),
    'update:check': () => updater.check(),
    'update:install': () => updater.install(),
    'kawaki:login': () => void kawaki.login(),
    'kawaki:logout': () => kawaki.logout(),
    'kawaki:cancelLogin': () => kawaki.cancelLogin(),
    'kawaki:refresh': () => kawaki.refresh(),
    'obs:addBrowserSource': async (name, url, width, height) => {
      const result = await obs.addBrowserSource(name, url, width, height);
      ctx.toast(result === 'exists' ? 'info' : 'success', `toast.obsSource_${result}`, { name, scene: state.current.obs.currentScene });
    },
    'media:import': async () => {
      const res = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openFile'],
        filters: [{ name: 'Media', extensions: [...IMAGE_EXT, ...AUDIO_EXT, ...VIDEO_EXT].map((e) => e.slice(1)) }],
      });
      if (res.canceled || !res.filePaths[0]) return null;
      const src = res.filePaths[0];
      const ext = extname(src).toLowerCase();
      const stem = basename(src, extname(src)).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'media';
      let name = `${stem}${ext}`;
      for (let i = 1; existsSync(join(mediaDir, name)); i++) name = `${stem}_${i}${ext}`;
      copyFileSync(src, join(mediaDir, name));
      return mediaInfo(name, overlay.port);
    },
    'media:list': () => listMedia(),
    'shell:openExternal': (url) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    },
    'clipboard:write': (text) => clipboard.writeText(text),
  });

  // ---------- window & tray ----------
  createWindow();
  createTray();

  // ---------- start ----------
  await startOverlay();
  text.start();
  ads.start();
  updater.start();
  bot.start();
  actions.registerHotkeys();
  obs.start();
  void twitch.start();
  void donationalerts.start();
  streamlabs.start();
  void kawaki.start();

  app.on('before-quit', () => {
    quitting = true;
    settings.flush();
    actions.dispose();
    twitch.stop();
    donationalerts.stop();
    streamlabs.stop();
    kawaki.stop();
    text.stop();
    ads.stop();
    updater.stop();
    boss.dispose();
    wheel.dispose();
    poll.dispose();
    giveaway.dispose();
    quiz.dispose();
    bot.stop();
    void obs.disconnect();
    void overlay.stop();
  });

  // Keep running in the tray: overlays must stay alive while OBS is open.
  app.on('window-all-closed', () => {
    if (!settings.get('minimizeToTray')) app.quit();
  });

  function createWindow(): void {
    mainWindow = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 980,
      minHeight: 640,
      show: false,
      backgroundColor: '#0e0e13',
      autoHideMenuBar: true,
      title: 'StreamHelper',
      icon: iconImage(),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    mainWindow.on('ready-to-show', () => mainWindow?.show());
    mainWindow.on('close', (e) => {
      if (!quitting && settings.get('minimizeToTray')) {
        e.preventDefault();
        mainWindow?.hide();
      }
    });
    mainWindow.on('closed', () => (mainWindow = null));
    // Links from chat etc. open in the system browser, never inside the app.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (e, url) => {
      const devUrl = process.env['ELECTRON_RENDERER_URL'];
      if (!(devUrl && url.startsWith(devUrl)) && !url.startsWith('file://')) e.preventDefault();
    });

    if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  function createTray(): void {
    tray?.destroy();
    const img = iconImage();
    tray = new Tray(img.isEmpty() ? img : img.resize({ width: 16, height: 16 }));
    tray.setToolTip('StreamHelper');
    const ru = settings.get('language') === 'ru';
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: ru ? 'Открыть StreamHelper' : 'Open StreamHelper', click: () => showWindow() },
        { label: ru ? 'Пауза / продолжить алерты' : 'Pause / resume alerts', click: () => alerts.togglePause() },
        { label: ru ? 'Пропустить алерт' : 'Skip alert', click: () => alerts.skip() },
        { type: 'separator' },
        { label: ru ? 'Выход' : 'Quit', click: () => app.quit() },
      ]),
    );
    tray.on('click', () => showWindow());
  }
}

function mediaInfo(name: string, port: number): MediaFile {
  const ext = extname(name).toLowerCase();
  const kind = AUDIO_EXT.includes(ext) ? 'audio' : VIDEO_EXT.includes(ext) ? 'video' : 'image';
  return { name, kind, url: `http://127.0.0.1:${port}/media/${encodeURIComponent(name)}` };
}
