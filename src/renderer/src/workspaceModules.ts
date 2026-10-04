import type { WorkspaceCard } from '@shared/types';
import type { IconName } from './components/icons';
import type { TKey } from './i18n';
import { OVERLAYS } from './overlayCatalog';

export type ModuleGroup = 'setup' | 'channel' | 'display' | 'fun' | 'automation';
export interface ModuleDef { id: WorkspaceCard; title?: TKey; name?: string; description: TKey; icon: IconName; group: ModuleGroup }
export const MODULES: ModuleDef[] = [
  { id:'twitch', name:'Twitch', description:'workspace.desc.connection', icon:'broadcast', group:'setup' },
  { id:'obs', name:'OBS', description:'workspace.desc.obs', icon:'video', group:'channel' },
  ...(['donationalerts','streamlabs','streamelements','streamerbot','discord'] as const).map((id): ModuleDef => ({ id, name:({donationalerts:'DonationAlerts',streamlabs:'Streamlabs',streamelements:'StreamElements',streamerbot:'Streamer.bot',discord:'Discord'})[id],description:'workspace.desc.connection',icon:'plug',group:'setup' })),
  { id:'subforstream', name:'SubForStream', description:'workspace.desc.subs', icon:'mic', group:'setup' },
  { id:'stream', title:'dash.stream', description:'workspace.desc.stream', icon:'broadcast', group:'channel' },
  { id:'bot', title:'nav.bot', description:'workspace.desc.bot', icon:'bot', group:'automation' },
  { id:'actions', title:'dash.quick', description:'workspace.desc.actions', icon:'zap', group:'automation' },
  ...OVERLAYS.map((o): ModuleDef => ({ id:o.kind, title:`ov.${o.kind}`, description:`ovDesc.${o.kind}`, icon:o.icon, group:o.group === 'fun' ? 'fun' : 'display' })),
];
export const moduleDef = (id: WorkspaceCard) => MODULES.find((m) => m.id === id)!;
