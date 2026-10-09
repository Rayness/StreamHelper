import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron';
import { ALERT_TYPES, type AlertType, type IpcPush, type Language, type MediaFile } from '@shared/types';
import { release } from 'node:os';
import { normalizeAppearance } from '@shared/defaults';

/** Mica / Acrylic window backdrops exist from Windows 11 22H2 (build 22621). */
const WINDOW_MATERIAL = process.platform === 'win32' && Number(release().split('.')[2] ?? 0) >= 22621;
import { BotService } from './bot/bot';
import type { AppContext } from './core/context';
import { EventBus } from './core/eventBus';
import { UpdateService } from './core/updater';
import { SecretStore } from './core/secrets';
import { StateHub } from './core/state';
import { SettingsStore } from './core/store';
import { DonationAlertsService } from './donations/donationalerts';
import { StreamlabsService } from './donations/streamlabs';
import { StreamElementsService } from './donations/streamelements';
import { StreamerBotService } from './integrations/streamerbot';
import { DiscordService } from './integrations/discord';
import { SubForStreamService } from './integrations/subForStream';
import { ActionRunner } from './features/actions';
import { AlertQueue } from './features/alerts';
import { OverlayTests } from './features/overlayTests';
import { TextOverlays } from './features/banners';
import { AdsService } from './features/ads';
import { BossService } from './features/boss';
import { ChatHistory, sampleChatMessage } from './features/chatHistory';
import { EmoteRain } from './features/emotes';
import { MusicService } from './features/music';
import { SongRequestService } from './features/songRequests';
import { GiveawayService } from './features/giveaway';
import { PollService } from './features/poll';
import { ProgressTracker } from './features/progress';
import { QuizService } from './features/quiz';
import { SpotlightService } from './features/spotlight';
import type { StageDeps } from './features/stage';
import { WheelService } from './features/wheel';
import { ViewerQueueService } from './features/viewerQueue';
import { GuessService } from './features/guess';
import { HypeService } from './features/hype';
import { ClipperService } from './features/clipper';
import { CurseService } from './features/curses';
import { DuelService } from './features/duel';
import { MelodyService } from './features/melody';
import { DuckingService } from './features/ducking';
import { MarketService } from './features/market';
import { PortalService } from './features/portal';
import { ReportService } from './features/report';
import { REPORT_HEIGHT, REPORT_WIDTH } from './features/reportCard';
import { ShieldService } from './features/shield';
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
    isUiVisible: () => !!mainWindow?.isVisible(),
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
  const streamelements = new StreamElementsService(ctx);
  const streamerbot = new StreamerBotService(ctx);
  const discord = new DiscordService(ctx);
  const subForStream = new SubForStreamService(ctx);
  const progress = new ProgressTracker(ctx);
  const updater = new UpdateService(ctx);
  const music = new MusicService(ctx);

  let overlay!: OverlayServer;
  const donationalerts = new DonationAlertsService(ctx, () => `http://127.0.0.1:${overlay.port}/auth/donationalerts`);
  const alerts = new AlertQueue(
    ctx,
    (alert) => overlay.broadcast('alerts', { type: 'alert', alert }),
    () => overlay.broadcast('alerts', { type: 'alertSkip' }),
  );
  const overlayTests = new OverlayTests(ctx, alerts, (kind, message) => overlay.broadcast(kind, message), (event) => push('event', event));
  let hub!: OverlayHub;
  let dockRoute!: ReturnType<typeof createDockRoutes>;
  let songRequests!: SongRequestService;
  let report!: ReportService;
  const playerErrors = { duel: (_id: string, _code: number) => undefined as void, melody: (_id: string, _code: number) => undefined as void };
  const authRoute = createAuthRoutes((token, expiresIn) => donationalerts.completeLogin(token, expiresIn));
  overlay = new OverlayServer({
    port: settings.get('overlayPort'),
    overlaysDir: join(resourcesDir(), 'overlays'),
    mediaDir,
    initialMessages: (kind, id) => hub.initialMessages(kind, id),
    onClientsChanged: (count, perKind) => {
      state.patch('overlayClients', count);
      state.replace('overlayKinds', perKind);
      songRequests?.setPlayerConnected((perKind.song ?? 0) > 0);
    },
    extraRoute: async (req, res, url) => {
      if (await authRoute(req, res, url)) return true;
      if (await dockRoute(req, res, url)) return true;
      const card = /^\/reports\/([\w-]+)\.png$/.exec(url.pathname);
      if (card && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = report.pngPath(card[1]);
        if (!existsSync(file)) { res.writeHead(404); res.end(); return true; }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
        if (req.method === 'HEAD') res.end(); else res.end(readFileSync(file));
        return true;
      }
      if (url.pathname === '/player/error' && req.method === 'POST') {
        // Duel / melody overlays report tracks YouTube refused to play.
        try {
          let body = '';
          for await (const chunk of req) { body += chunk.toString(); if (body.length > 512) throw new Error('Request too large'); }
          const data = JSON.parse(body) as { kind?: unknown; videoId?: unknown; code?: unknown };
          const code = Number(data.code);
          if (typeof data.videoId !== 'string' || !Number.isFinite(code)) throw new Error('Invalid request');
          if (data.kind === 'duel') playerErrors.duel(data.videoId, code);
          else if (data.kind === 'melody') playerErrors.melody(data.videoId, code);
          res.writeHead(204); res.end();
        } catch { res.writeHead(400); res.end(); }
        return true;
      }
      if (url.pathname !== '/song/finished') return false;
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return true; }
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString();
          if (body.length > 1024) throw new Error('Request too large');
        }
        const data = JSON.parse(body) as { id?: unknown; nonce?: unknown; error?: unknown; kind?: unknown };
        if (typeof data.id !== 'string' || typeof data.nonce !== 'string') throw new Error('Invalid request');
        const accepted = await songRequests.playerFinished(data.id, data.nonce, typeof data.error === 'string' ? data.error : '', data.kind === 'video' ? 'video' : 'player');
        res.writeHead(accepted ? 204 : 409); res.end();
      } catch { res.writeHead(400); res.end(); }
      return true;
    },
  });

  songRequests = new SongRequestService(ctx, music, (message) => overlay.broadcast('song', message), (text, replyTo) => twitch.sendMessage(text, replyTo), {
    rewards: { settle: (rewardId, redemptionId, status) => twitch.settleRedemption(rewardId, redemptionId, status) },
  });

  const sendToAllChats = async (text: string) => {
    const ready = platforms.ready();
    if (!ready.length) throw new Error('chat is not connected');
    await Promise.all(ready.map((p) => p.sendMessage(text)));
  };
  const stage: StageDeps = {
    broadcast: (kind, msg, id) => {
      if (kind === 'ad') overlay.forEachClient('ad', (clientId) => ads.overlayMessage(clientId));
      else overlay.broadcast(kind, msg, id);
    },
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
  const viewerQueue = new ViewerQueueService(ctx, stage);
  const guess = new GuessService(ctx, stage);
  const hype = new HypeService(ctx, stage);
  const text = new TextOverlays(ctx, () => overlay);
  const clipper = new ClipperService(ctx, {
    createClip: () => twitch.createClip(),
    createMarker: (description) => twitch.createMarker(description),
    say: (msg) => sendToAllChats(msg),
    discord: (msg) => discord.notify(msg),
  });
  const curses = new CurseService(ctx, stage, {
    setFilterEnabled: (source, filter, enabled) => obs.setFilterEnabled(source, filter, enabled),
    setSourceVisible: (scene, source, visible) => obs.setSourceVisible(scene, source, visible),
    setMute: (input, muted) => obs.setMute(input, muted),
  });
  const duel = new DuelService(ctx, stage, {
    upcoming: () => state.current.songRequests.queue,
    hasCurrent: () => !!state.current.songRequests.current,
    isPaused: () => state.current.songRequests.paused,
    pause: (paused) => songRequests.pause(paused),
    move: (id, index) => songRequests.move(id, index),
    play: (id) => songRequests.play(id),
    remove: (id) => songRequests.remove(id),
  });
  const melody = new MelodyService(ctx, stage);
  playerErrors.duel = (id, code) => duel.playerError(id, code);
  playerErrors.melody = (id, code) => melody.playerError(id, code);
  const ducking = new DuckingService(ctx, obs);
  const market = new MarketService(ctx, stage, join(userData, 'market.json'));
  const portal = new PortalService(ctx, {
    broadcast: (msg) => overlay.broadcast('portal', msg),
    say: (msg) => sendToAllChats(msg),
    lookup: (login) => twitch.channelName(login),
  });
  report = new ReportService(ctx, {
    dir: join(userData, 'reports'),
    sessionFile: join(userData, 'report-session.json'),
    render: (html) => renderHtmlToPng(html, REPORT_WIDTH, REPORT_HEIGHT),
    imageUrl: (id) => `http://127.0.0.1:${overlay.port}/reports/${id}.png`,
    say: (msg) => sendToAllChats(msg),
    discord: (msg, png, filename) => discord.sendImage(msg, png, filename),
  });
  const shield = new ShieldService(ctx, {
    getChatSettings: () => twitch.getChatSettings(),
    updateChatSettings: (modes) => twitch.updateChatSettings(modes),
    setShieldMode: (active) => twitch.setShieldMode(active),
    deleteMessage: (id) => twitch.deleteMessage(id),
    timeout: (userId, seconds, reason) => twitch.timeout(userId, seconds, reason),
    accountAges: (ids) => twitch.getAccountAges(ids),
    say: (msg) => sendToAllChats(msg),
  }, join(userData, 'shield-known.json'));
  hub = new OverlayHub(ctx, overlay, chatHistory, {
    alerts: () => alerts,
    text: () => text,
    poll: () => poll.overlayMessage(),
    giveaway: () => giveaway.overlayMessage(),
    quiz: () => quiz.overlayMessage(),
    boss: () => boss.overlayMessage(),
    ad: (id) => ads.overlayMessage(id),
    song: () => songRequests.overlayMessage,
    spotlight: () => spotlight.overlayMessage(),
    queue: () => viewerQueue.overlayMessage(),
    guess: () => guess.overlayMessage(),
    hype: () => hype.hypeMessage(),
    leaders: () => hype.leadersMessage(),
    curse: () => curses.overlayMessage(),
    duel: () => duel.overlayMessage(),
    melody: () => melody.overlayMessage(),
    stocks: () => market.overlayMessage(),
    portal: () => portal.configMessage(),
  });

  const bot = new BotService(ctx, platforms, twitch, songRequests);
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
    streamerbotAction: (id) => streamerbot.run(id),
    clipMoment: () => clipper.clipNow(),
    shieldToggle: () => shield.toggle(),
    curseVote: () => curses.startVote(),
  });
  dockRoute = createDockRoutes({
    token: dockToken,
    htmlPath: join(resourcesDir(), 'overlays', 'dock.html'),
    snapshot: () => ({ state: state.current, settings: settings.all, chat: chatHistory.recent(20) }),
    action: async (name, id) => {
      switch (name) {
        case 'stream': return obs.stream('toggle');
        case 'record': return obs.record('toggle');
        case 'scene': if (id) return obs.setScene(id); break;
        case 'sourceToggle': if (id && Number.isInteger(Number(id))) return obs.toggleSceneItem(state.current.obs.currentScene, Number(id)); break;
        case 'muteToggle': if (id) return obs.toggleMute(id); break;
        case 'profileActivate': if (id) return void settings.activateProfile(id); break;
        case 'alertsPause': return alerts.togglePause();
        case 'alertsSkip': return alerts.skip();
        case 'alertsTest': if (id && ALERT_TYPES.includes(id as AlertType)) { overlayTests.alert(id as AlertType); return; } break;
        case 'pollStart': return poll.start();
        case 'pollEnd': return poll.end();
        case 'pollClear': return poll.clear();
        case 'giveawayOpen': return giveaway.open();
        case 'giveawayClose': return giveaway.close();
        case 'giveawayRoll': return giveaway.roll();
        case 'giveawayReset': return giveaway.reset();
        case 'bossStart': return boss.start();
        case 'bossHit': return void boss.hit();
        case 'bossReset': return boss.reset();
        case 'quizStart': return void quiz.start();
        case 'quizSkip': return quiz.skip();
        case 'quizStop': return quiz.stop();
        case 'wheelSpin': if (id) return wheel.spin(id); break;
        case 'emoteBurst': return emotes.burst();
        case 'adShow': if (id) return ads.show(id); break;
        case 'adHide': return ads.hide();
        case 'songPlay': return songRequests.play(id);
        case 'songAdd': if (id) return songRequests.add(id); break;
        case 'songSkip': return songRequests.skip();
        case 'songRemove': if (id) return songRequests.remove(id); break;
        case 'songVideoLayout': if (id === 'full' || id === 'compact' || id === 'queue') return void settings.set('songRequests', { ...settings.get('songRequests'), videoLayout: id }); break;
        case 'songVolume': if (id !== undefined && /^\d{1,3}$/.test(id)) return void settings.set('songRequests', { ...settings.get('songRequests'), volume: Math.max(0, Math.min(100, Number(id))) }); break;
        case 'musicArtwork': return void settings.set('musicOverlay', { ...settings.get('musicOverlay'), showArtwork: !settings.get('musicOverlay').showArtwork });
        case 'musicPlay': if (id === 'spotify' || id === 'yandex' || id === 'browser' || id === 'other') return music.control(id, 'play'); break;
        case 'musicPause': if (id === 'spotify' || id === 'yandex' || id === 'browser' || id === 'other') return music.control(id, 'pause'); break;
        case 'musicNext': if (id === 'spotify' || id === 'yandex' || id === 'browser' || id === 'other') return music.control(id, 'next'); break;
        case 'bannerToggle': if (id) return text.toggle(id); break;
        case 'goalReset': if (id) { const goal = settings.get('goals').find((item) => item.id === id); if (goal) return progress.addToGoal(id, -goal.current); } break;
        case 'goalAdd': if (id) return progress.addToGoal(id, 1); break;
        case 'timerStart': if (id) return progress.controlTimer(id, 'start'); break;
        case 'timerPause': if (id) return progress.controlTimer(id, 'pause'); break;
        case 'timerReset': if (id) return progress.controlTimer(id, 'reset'); break;
        case 'timerAdd': if (id) return progress.controlTimer(id, 'add', 60); break;
        case 'kawakiRefresh': return kawaki.refresh();
        case 'subsClear': return subForStream.clear();
        case 'quickAction': if (id) return actions.run(id); break;
        case 'spotlightClear': return spotlight.clear();
        case 'spotlightShow': if (id) return spotlight.show(id); break;
        case 'queueOpen': return viewerQueue.setOpen(!state.current.viewerQueue.open);
        case 'queueNext': return void viewerQueue.next(id === 'random');
        case 'queueClear': return viewerQueue.clear();
        case 'guessStart': return guess.start();
        case 'guessStop': return guess.stop();
        case 'hypeReset': return hype.reset();
        case 'counterAdd': if (id) { const [name, delta] = id.split(':'); if (name && /^-?\d{1,4}$/.test(delta ?? '')) return void bot.addCounter(name, Number(delta)); } break;
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
    }, mainWindow?.isVisible() ? 100 : 1000);
  });
  let settingsTimer: NodeJS.Timeout | null = null;
  let lastSongListen = settings.get('songRequests').listen;
  bus.on('settings:changed', (key) => {
    if (key === 'overlayPort') void startOverlay(true);
    if (key === 'language') createTray();
    if (key === 'appearance') applyAppearance();
    if (key === 'songRequests' || key === 'profiles') {
      const listen = settings.get('songRequests').listen;
      if (listen !== lastSongListen) { lastSongListen = listen; void obs.applySongAudio(); }
    }
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

  let overlayChanges: Promise<void> = Promise.resolve();
  function startOverlay(restart = false): Promise<void> {
    const operation = overlayChanges.then(() => changeOverlay(restart));
    overlayChanges = operation.catch(() => undefined);
    return operation;
  }

  async function changeOverlay(restart: boolean): Promise<void> {
    const port = settings.get('overlayPort');
    try {
      if (restart) await overlay.restart(port);
      else await overlay.start();
      // "localhost", not the IP: YouTube refuses label/music videos embedded on an IP address (error 150).
      state.patch('overlayUrl', `http://localhost:${port}`);
      state.patch('dockUrl', `http://127.0.0.1:${port}/dock?token=${dockToken}`);
    } catch (err) {
      console.error('[overlay] cannot listen', err);
      state.patch('overlayUrl', '');
      state.patch('dockUrl', '');
      ctx.toast('error', 'toast.overlayPortBusy', { port });
    }
    if (restart && state.current.overlayUrl) await obs.repairBrowserSources().catch((err) => console.warn('[obs] repair after port change', err));
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
      windowMaterial: WINDOW_MATERIAL,
    }),
    'settings:set': (key, value, profileId, base) => { settings.setForProfile(key, value, profileId, base); return settings.all; },
    'settings:reset': (key) => {
      settings.reset(key);
      return settings.all;
    },
    'profiles:create': (name, mode) => settings.createProfile(name, mode),
    'profiles:rename': (id, name) => settings.renameProfile(id, name),
    'profiles:activate': (id) => settings.activateProfile(id),
    'profiles:delete': (id) => settings.deleteProfile(id),
    'profiles:overlay': (id, kind, enabled) => settings.setProfileOverlay(id, kind, enabled),
    'twitch:login': (acc) => void twitch.login(acc),
    'twitch:logout': (acc) => twitch.logout(acc),
    'twitch:cancelLogin': (acc) => twitch.cancelLogin(acc),
    'twitch:updateStream': (patch) => twitch.updateStream(patch),
    'twitch:searchCategories': (q) => twitch.searchCategories(q),
    'twitch:rewards': () => twitch.listRewards(),
    'twitch:createSongReward': async (title, cost) => {
      try {
        return await twitch.createSongReward(title, cost);
      } catch (error) {
        const status = (error as { status?: number }).status;
        const ru = settings.get('language') === 'ru';
        if (status === 401 || status === 403) throw new Error(ru ? 'Нет права управлять наградами. Переподключите Twitch в «Подключениях» и попробуйте снова.' : 'No permission to manage rewards. Reconnect Twitch in Connections and try again.');
        if (status === 400 && /DUPLICATE/i.test(String((error as Error).message))) throw new Error(ru ? 'Награда с таким названием уже есть. Выберите её из списка или смените название.' : 'A reward with this title already exists. Pick it from the list or change the title.');
        throw error;
      }
    },
    'chat:send': async (text, replyTo) => {
      const p = platforms.get('twitch');
      if (!p?.isChatReady()) throw new Error('chat is not connected');
      const botToken = secrets.get('twitchBot');
      await p.sendMessage(text, replyTo, { asBroadcaster: !botToken || botToken.userId === twitch.broadcasterId });
    },
    'chat:delete': (id) => twitch.deleteMessage(id),
    'chat:timeout': (userId, sec) => twitch.timeout(userId, sec),
    'chat:ban': (userId) => twitch.ban(userId),
    'chat:test': () => bus.emit('chat:message', sampleChatMessage(settings.get('language'))),
    'da:login': () => donationalerts.login(),
    'da:logout': () => donationalerts.logout(),
    'streamlabs:connect': (token) => streamlabs.connect(token),
    'streamlabs:disconnect': () => streamlabs.disconnect(),
    'streamelements:connect': (channelId, token) => streamelements.connect(channelId, token),
    'streamelements:disconnect': () => streamelements.disconnect(),
    'streamerbot:connect': (port) => streamerbot.connect(port),
    'streamerbot:disconnect': () => streamerbot.disconnect(),
    'streamerbot:refresh': () => streamerbot.refresh(),
    'discord:connect': (url) => discord.connect(url),
    'discord:disconnect': () => discord.disconnect(),
    'discord:test': () => discord.test(),
    'obs:connect': (password) => obs.connect(password),
    'obs:disconnect': () => obs.disconnect(),
    'obs:setScene': (s) => obs.setScene(s),
    'obs:toggleSource': (scene, id) => obs.toggleSceneItem(scene, id),
    'obs:toggleMute': (input) => obs.toggleMute(input),
    'obs:stream': (m) => obs.stream(m),
    'obs:record': (m) => obs.record(m),
    'alerts:test': (type, donationAmount, tierId) => overlayTests.alert(type, donationAmount, tierId),
    'overlays:test': (kind, type) => overlayTests.widget(kind, type),
    'alerts:pause': (paused) => alerts.setPaused(paused),
    'alerts:skip': () => alerts.skip(),
    'alerts:replay': (id) => alerts.replay(id),
    'actions:run': (id) => actions.run(id),
    'timer:control': (id, op, sec) => progress.controlTimer(id, op, sec),
    'banner:showNow': (id) => text.showNow(id),
    'song:add': (url) => songRequests.addManual(url),
    'song:play': (id) => songRequests.play(id),
    'song:skip': () => songRequests.skip(),
    'song:remove': (id) => songRequests.remove(id),
    'song:pause': (paused) => songRequests.pause(paused),
    'song:move': (id, index) => songRequests.move(id, index),
    'music:control': (source, action) => music.control(source, action),
    'subs:check': () => subForStream.check(),
    'subs:clear': () => subForStream.clear(),
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
    'spotlight:test': () => spotlight.test(),
    'spotlight:clear': () => spotlight.clear(),
    'queue:open': (open) => viewerQueue.setOpen(open),
    'queue:next': (random) => void viewerQueue.next(!!random),
    'queue:remove': (userId) => viewerQueue.remove(userId),
    'queue:clear': () => viewerQueue.clear(),
    'guess:start': () => guess.start(),
    'guess:stop': () => guess.stop(),
    'counter:add': (name, delta) => void bot.addCounter(name, delta),
    'hype:add': (points) => hype.add(points),
    'hype:reset': () => hype.reset(),
    'leaders:reset': () => hype.resetLeaders(),
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
    'obs:sources': () => obs.listSources(),
    'obs:filters': (source) => obs.listFilters(source),
    'clipper:clip': async () => { await clipper.clipNow(); },
    'curse:vote': () => curses.startVote(),
    'curse:apply': (id) => curses.apply(id),
    'curse:lift': () => curses.lift(),
    'curse:cancel': () => curses.cancel(),
    'duel:start': (a, b) => duel.start(a, b),
    'duel:stop': () => duel.stop(),
    'melody:start': () => melody.start(),
    'melody:skip': () => melody.skip(),
    'melody:stop': () => melody.stop(),
    'melody:add': (urls) => melody.add(urls),
    'melody:fromSongs': () => {
      const sr = state.current.songRequests;
      return melody.addFromSongs([...(sr.current ? [sr.current] : []), ...sr.queue]);
    },
    'market:reset': () => market.reset(),
    'market:grant': (login, amount) => market.grant(login, amount),
    'portal:test': () => portal.test(),
    'report:generate': async () => { await report.generate(); },
    'report:reset': () => report.reset(),
    'report:delete': (id) => report.remove(id),
    'report:open': (id) => {
      if (id) shell.showItemInFolder(report.pngPath(id));
      else void shell.openPath(join(userData, 'reports'));
    },
    'report:copy': (id) => clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(readFileSync(report.pngPath(id)))], { type: 'image/png' }) })]),
    'report:discord': (id) => report.resend(id),
    'shield:activate': () => shield.activate(),
    'shield:release': async () => { await shield.release(); },
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
  hype.start();
  updater.start();
  music.start();
  bot.start();
  actions.registerHotkeys();
  obs.start();
  void twitch.start();
  void donationalerts.start();
  streamlabs.start();
  streamelements.start();
  streamerbot.start();
  discord.start();
  subForStream.start();
  void kawaki.start();
  ducking.start();
  portal.start();
  report.start();
  shield.start();

  // OBS and chat changes that must be undone before quitting (curse, ducked music, locked chat).
  // Their requests need OBS and Twitch still connected, so quitting waits for them (a few seconds at most).
  let undoneBeforeQuit = false;
  app.on('before-quit', (event) => {
    quitting = true;
    if (!undoneBeforeQuit && (curses.needsShutdown || ducking.needsShutdown || shield.needsShutdown)) {
      undoneBeforeQuit = true;
      event.preventDefault();
      const done = Promise.allSettled([curses.shutdown(), ducking.shutdown(), shield.shutdown()]);
      void Promise.race([done, new Promise((r) => setTimeout(r, 4000))]).finally(() => app.quit());
      return;
    }
    undoneBeforeQuit = true;
    settings.flush();
    alerts.dispose();
    actions.dispose();
    twitch.stop();
    donationalerts.stop();
    streamlabs.stop();
    streamelements.stop();
    streamerbot.stop();
    subForStream.stop();
    kawaki.stop();
    text.stop();
    ads.stop();
    hype.stop();
    viewerQueue.dispose();
    guess.dispose();
    updater.stop();
    music.stop();
    boss.dispose();
    wheel.dispose();
    poll.dispose();
    giveaway.dispose();
    quiz.dispose();
    clipper.dispose();
    curses.dispose();
    duel.dispose();
    melody.dispose();
    ducking.dispose();
    market.dispose();
    portal.stop();
    report.dispose();
    shield.dispose();
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
    applyAppearance();
    mainWindow.webContents.on('did-finish-load', applyAppearance);
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

  /** Window-level part of the appearance: system backdrop (Windows 11), light/dark frame, zoom. */
  function applyAppearance(): void {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    const look = normalizeAppearance(settings.get('appearance'));
    nativeTheme.themeSource = look.theme === 'light' ? 'light' : 'dark';
    const material = look.glass && WINDOW_MATERIAL ? look.windowMaterial : 'none';
    try {
      // Without a transparent background colour the backdrop stays hidden behind it.
      win.setBackgroundColor(material === 'none' ? (look.theme === 'light' ? '#f4f4f8' : '#0e0e13') : '#00000000');
      win.setBackgroundMaterial(material);
    } catch {
      /* older Windows: the CSS glass still works */
    }
    win.webContents.setZoomFactor(look.scale / 100);
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

/** Render a self-contained HTML page to PNG in an invisible window (the stream recap card). */
async function renderHtmlToPng(html: string, width: number, height: number): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: { offscreen: true, javascript: false, sandbox: true, zoomFactor: 1 },
  });
  try {
    let frame: Electron.NativeImage | null = null;
    win.webContents.on('paint', (_event, _dirty, image) => { frame = image; });
    win.webContents.setFrameRate(15);
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // Emote images load from Twitch's CDN; give them a moment, then force a fresh frame.
    await new Promise((r) => setTimeout(r, 900));
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 250));
    const painted = frame as Electron.NativeImage | null;
    const image = painted && !painted.isEmpty() ? painted : await win.webContents.capturePage();
    const size = image.getSize();
    return (size.width !== width ? image.resize({ width, height }) : image).toPNG();
  } finally {
    win.destroy();
  }
}

function mediaInfo(name: string, port: number): MediaFile {
  const ext = extname(name).toLowerCase();
  const kind = AUDIO_EXT.includes(ext) ? 'audio' : VIDEO_EXT.includes(ext) ? 'video' : 'image';
  return { name, kind, url: `http://127.0.0.1:${port}/media/${encodeURIComponent(name)}` };
}
