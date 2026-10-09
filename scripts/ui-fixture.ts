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
import { OverlayServer } from '../src/main/overlay/server';

export async function createFixture(root: string, dataDir: string, push: (channel: string, value: unknown) => void) {
  const bus = new EventBus();
  const settings = new SettingsStore(join(dataDir, 'settings.json'), bus, 'ru');
  const state = new StateHub(bus);
  const ctx = { bus, settings, state, toast: () => undefined } as unknown as AppContext;
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
      return base;
    },
  });
  await overlay.start();
  state.patch('overlayUrl', `http://localhost:${overlay.port}`);
  state.patch('twitch', { status: 'connected', account: { userId: 'fixture', login: 'streamer', displayName: 'Streamer' } });
  alerts = new AlertQueue(ctx, (alert) => overlay.broadcast('alerts', { type: 'alert', alert }), () => overlay.broadcast('alerts', { type: 'alertSkip' }));
  songs = new SongRequestService(ctx, { pauseCurrent: async () => null, resumeSource: async () => undefined } as any, (message) => overlay.broadcast('song', message), undefined, { lookup: async () => ({ ok: true, title: 'Тестовый трек' }) });
  const testBroadcasts: {kind:OverlayKind;message:OverlayMessage}[] = [];
  const broadcast = (kind:OverlayKind,message:OverlayMessage) => {testBroadcasts.push({kind,message});overlay.broadcast(kind,message);};
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
        case 'app:init': return { settings: settings.all, state: state.current, chat: [chat], events: [], version: '0.10.1 QA' };
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
        case 'twitch:rewards': return [{ id: 'song-reward', title: 'Заказ музыки', inputRequired: true, enabled: true, manageable: true }];
        case 'twitch:createSongReward': return { id: 'song-reward', title: args[0] };
        case 'alerts:test': return overlayTests.alert(args[0],args[1],args[2]);
        case 'overlays:test': return overlayTests.widget(args[0],args[1]);
        case 'alerts:pause': return alerts.setPaused(args[0]);
        case 'alerts:skip': return alerts.skip();
        case 'twitch:searchCategories': return [];
        case 'clipboard:write': return;
        default: throw new Error('Unhandled QA action: ' + channel);
      }
    },
    async stop() { alerts.dispose(); settings.flush(); await overlay.stop(); },
  };
}
