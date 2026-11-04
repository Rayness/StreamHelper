import { join } from 'node:path';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { SettingsStore } from '../src/main/core/store';
import type { AppContext } from '../src/main/core/context';
import type { IpcInvoke, OverlayKind, OverlayMessage } from '../src/shared/types';
import { sampleChatMessage } from '../src/main/features/chatHistory';
import { sampleEvent, AlertQueue } from '../src/main/features/alerts';
import { OverlayTests } from '../src/main/features/overlayTests';
import { EmoteRain } from '../src/main/features/emotes';
import { SongRequestService } from '../src/main/features/songRequests';
import { TtsService } from '../src/main/features/tts';
import { CaptionsService } from '../src/main/features/captions';
import { OverlayServer } from '../src/main/overlay/server';
import { version } from '../package.json';
import type { SecretsData } from '../src/main/core/secrets';
import { SceneStudioService } from '../src/main/sceneStudio/service';
import { defaultSceneAiConfig } from '../src/shared/sceneAi';
import { createServer } from 'node:net';

export async function createFixture(root: string, dataDir: string, push: (channel: string, value: unknown) => void) {
  const bus = new EventBus();
  const settings = new SettingsStore(join(dataDir, 'settings.json'), bus, 'ru');
  const state = new StateHub(bus);
  const secrets: SecretsData = { sceneStudio: { config: defaultSceneAiConfig() } };
  const ctx = { bus, settings, state, mediaDir: dataDir, toast: () => undefined,
    secrets: { get: (key: keyof SecretsData) => secrets[key], set: (key: keyof SecretsData, value: never) => { secrets[key] = value; } } } as unknown as AppContext;
  const chat = sampleChatMessage('ru'); chat.fragments = [{ type: 'text', text: chat.text }];
  let alerts: AlertQueue;
  let songs: SongRequestService;
  const overlay = new OverlayServer({ port: 0, overlaysDir: join(root, 'resources/overlays'), mediaDir: dataDir,
    onClientsChanged: (count, perKind) => { state.patch('overlayClients', count); state.patch('overlayKinds', perKind); songs?.setPlayerConnected(!!perKind.song); },
    initialMessages: (kind: OverlayKind): OverlayMessage[] => {
      const base: OverlayMessage[] = [{ type: 'profileVisibility', visible: true }];
      if (kind === 'chat') base.push({ type: 'chatConfig', config: settings.get('chatOverlay') }, { type: 'chat', message: chat });
      if (kind === 'song') base.push(songs.overlayMessage);
      // The stream tools pack: idle state, the overlays draw their own preview sample.
      const now = Date.now();
      if (kind === 'curse') base.push({ type: 'curse', curse: state.current.curse, style: settings.get('curses'), now, lang: 'ru' });
      if (kind === 'duel') base.push({ type: 'duel', duel: state.current.duel, style: settings.get('duel'), now, lang: 'ru' });
      if (kind === 'melody') base.push({ type: 'melody', melody: state.current.melody, style: settings.get('melody'), now, lang: 'ru' });
      if (kind === 'stocks') base.push({ type: 'stocks', quotes: [], lastTrade: null, style: settings.get('market'), lang: 'ru' });
      if (kind === 'portal') base.push({ type: 'portalConfig', config: settings.get('portal'), channel: '', lang: 'ru' });
      if (kind === 'focus') base.push({ type: 'focus', focus: state.current.focus, style: settings.get('focus'), task: '', now, lang: 'ru' });
      if (kind === 'shoutout') base.push({ type: 'shoutout', card: null, endsAt: null, style: settings.get('shoutout'), now, lang: 'ru' });
      if (kind === 'captions') base.push({ type: 'captions', lines: [], interim: '', style: settings.get('captions'), lastAt: null, now, lang: 'ru' });
      return base;
    },
  });
  await overlay.start();
  state.patch('overlayUrl', `http://localhost:${overlay.port}`);
  state.patch('twitch', { status: 'connected', account: { userId: 'fixture', login: 'streamer', displayName: 'Streamer' } });
  alerts = new AlertQueue(ctx, (alert) => overlay.broadcast('alerts', { type: 'alert', alert }), () => overlay.broadcast('alerts', { type: 'alertSkip' }));
  songs = new SongRequestService(ctx, { pauseCurrent: async () => null, resumeSource: async () => undefined } as any, (message) => overlay.broadcast('song', message), undefined, { lookup: async () => ({ ok: true, title: 'Тестовый трек' }), playlistLookup: async () => ({ ok: true, title: 'Тестовый плейлист' }), details: async () => null, search: async () => [{ videoId: 'dQw4w9WgXcQ', title: 'Тестовый трек' }], yandexTrack: async (trackId) => ({ trackId, title: 'Тестовый исполнитель - Тестовый трек', available: true }), yandexSearch: async () => [] });
  const testBroadcasts: {kind:OverlayKind;message:OverlayMessage}[] = [];
  const broadcast = (kind:OverlayKind,message:OverlayMessage) => {testBroadcasts.push({kind,message});overlay.broadcast(kind,message);};
  // Exercise the real queue and IPC without starting Windows speech or playing audio.
  const tts = new TtsService(ctx, {
    broadcast: (message) => broadcast('tts', message),
    voices: async () => [{ name: 'QA Russian', lang: 'ru-RU', gender: 'male', source: 'sapi' }],
    speak: async () => ({ url: 'data:audio/wav;base64,', wav: new Uint8Array() }),
    say: async () => undefined, loadUserVoices: () => ({}), saveUserVoices: () => undefined,
  });
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  secrets.sceneStudio!.mcpPort = (probe.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const studio = new SceneStudioService(ctx, alerts, (scene, event) => push('scene:preview', { scene, event }), async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).input);
    const generated = { ...input.scene, html: '<main><h1>AI draft</h1><p data-field="user"></p></main>', css: 'body{color:white;background:transparent;font-family:Segoe UI}', js: '', published: false };
    return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(generated) }] }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  // Only captions with text count as test broadcasts; settings changes just restyle the overlay.
  const captions = new CaptionsService(ctx, { broadcast: (message) => message.type === 'captions' && (message.lines.length || message.interim) ? broadcast('captions', message) : overlay.broadcast('captions', message) });
  new EmoteRain(ctx,{broadcast} as any);
  const overlayTests = new OverlayTests(ctx,alerts,broadcast,(event) => push('event',event));
  bus.on('settings:changed', () => push('settings', settings.all));
  bus.on('state:dirty', () => push('state', state.current));
  const calls: { channel: string; args: unknown[] }[] = [];
  return {
    calls, settings, state, songs, testBroadcasts,
    async invoke(channel: string, ...args: any[]) {
      calls.push({ channel, args });
      switch (channel as keyof IpcInvoke) {
        case 'scene:test': return studio.preview(args[0], args[1]);
        case 'scene:ai:get': return studio.ai.getConfig();
        case 'scene:ai:configure': return studio.ai.configure(args[0], args[1]);
        case 'scene:ai:generate': return studio.ai.generate(args[0]);
        case 'scene:mcp:status': return studio.status();
        case 'scene:mcp:configure': return studio.configure(args[0], args[1]);
        case 'scene:mcp:rotate': return studio.rotate();
        case 'app:init': return { settings: settings.all, state: state.current, chat: [chat], events: [], version: `${version} QA` };
        case 'settings:reset': settings.reset(args[0]); return settings.all;
        case 'settings:set': settings.setForProfile(args[0], args[1], args[2], args[3]); return settings.all;
        case 'profiles:create': return settings.createProfile(args[0],args[1]);
        case 'profiles:activate': return settings.activateProfile(args[0]);
        case 'profiles:overlay': return settings.setProfileOverlay(args[0], args[1], args[2]);
        case 'chat:send': {
          const message = { ...chat, id:'sent-'+Date.now(), text:args[0], fragments:[{type:'text',text:args[0]}], fromSelf:true };
          push('chat:message',message); return;
        }
        case 'media:list': return [];
        case 'song:add': return songs.addManual(args[0]);
        case 'song:move': return songs.move(args[0], args[1]);
        case 'song:pause': return songs.pause(args[0]);
        case 'song:remove': return songs.remove(args[0]);
        case 'song:skip': return songs.skip();
        case 'song:banUser': return songs.banUser(args[0]);
        case 'song:banVideo': return songs.banVideo(args[0]);
        case 'song:backgroundAdd': return songs.addBackground(args[0]);
        case 'song:jamAdd': return songs.addJam(args[0], args[1]);
        case 'twitch:rewards': return [{ id: 'song-reward', title: 'Заказ музыки', inputRequired: true, enabled: true, manageable: true }];
        case 'twitch:createSongReward': return { id: 'song-reward', title: args[0] };
        case 'tts:test': return tts.test(args[0]);
        case 'tts:skip': return tts.skip();
        case 'tts:clear': return tts.clear();
        case 'tts:voices': return tts.refreshVoices();
        case 'tts:forgetVoices': return tts.forgetVoices();
        case 'captions:test': return captions.test();
        case 'captions:clear': return captions.clear();
        case 'alerts:test': return overlayTests.alert(args[0],args[1],args[2]);
        case 'overlays:test': return overlayTests.widget(args[0],args[1]);
        case 'alerts:pause': return alerts.setPaused(args[0]);
        case 'alerts:skip': return alerts.skip();
        case 'twitch:searchCategories': return [];
        case 'clipboard:write': return;
        case 'fonts:system': return ['Arial', 'Segoe UI', 'Times New Roman'];
        case 'counter:add': settings.update('bot', (b) => ({ ...b, counters: { ...b.counters, [args[0]]: (b.counters[args[0]] ?? 0) + args[1] } })); return;
        case 'donations:clear': settings.set('donationLog', []); return;
        default: throw new Error('Unhandled QA action: ' + channel);
      }
    },
    async stop() { alerts.dispose(); tts.dispose(); captions.dispose(); settings.flush(); await studio.stop(); await overlay.stop(); },
  };
}
