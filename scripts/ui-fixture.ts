import { join } from 'node:path';
import { EventBus } from '../src/main/core/eventBus';
import { StateHub } from '../src/main/core/state';
import { SettingsStore } from '../src/main/core/store';
import type { AppContext } from '../src/main/core/context';
import type { IpcInvoke, OverlayKind, OverlayMessage } from '../src/shared/types';
import { sampleChatMessage } from '../src/main/features/chatHistory';
import { sampleEvent, AlertQueue } from '../src/main/features/alerts';
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
      return base;
    },
  });
  await overlay.start();
  state.patch('overlayUrl', `http://127.0.0.1:${overlay.port}`);
  state.patch('twitch', { status: 'connected', account: { userId: 'fixture', login: 'streamer', displayName: 'Streamer' } });
  alerts = new AlertQueue(ctx, (alert) => overlay.broadcast('alerts', { type: 'alert', alert }), () => overlay.broadcast('alerts', { type: 'alertSkip' }));
  songs = new SongRequestService(ctx, { pauseCurrent: async () => null, resumeSource: async () => undefined } as any, (message) => overlay.broadcast('song', message));
  bus.on('settings:changed', () => push('settings', settings.all));
  bus.on('state:dirty', () => push('state', state.current));
  const calls: { channel: string; args: unknown[] }[] = [];
  return {
    calls, settings, state, songs,
    async invoke(channel: string, ...args: any[]) {
      calls.push({ channel, args });
      switch (channel as keyof IpcInvoke) {
        case 'app:init': return { settings: settings.all, state: state.current, chat: [chat], events: [], version: '0.10.0 QA' };
        case 'settings:reset': settings.reset(args[0]); return settings.all;
        case 'settings:set': settings.setForProfile(args[0], args[1], args[2], args[3]); return settings.all;
        case 'profiles:create': return settings.createProfile(args[0]);
        case 'profiles:activate': return settings.activateProfile(args[0]);
        case 'profiles:overlay': return settings.setProfileOverlay(args[0], args[1], args[2]);
        case 'chat:send': {
          const message = { ...chat, id:'sent-'+Date.now(), text:args[0], fragments:[{type:'text',text:args[0]}], fromSelf:true };
          push('chat:message',message); return;
        }
        case 'media:list': return [];
        case 'song:add': return songs.add(args[0]);
        case 'twitch:rewards': return [{ id: 'song-reward', title: 'Заказ музыки', inputRequired: true, enabled: true }];
        case 'alerts:test': bus.emit('event', sampleEvent(args[0], 'ru', 'RUB', args[1])); return;
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
