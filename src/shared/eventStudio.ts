import type { AlertType, Language, StreamEvent } from './types';

export type SceneParameter = string | number | boolean;
export interface EventScene {
  id: string;
  name: string;
  eventType: AlertType | 'any';
  html: string;
  css: string;
  js: string;
  width: number;
  height: number;
  durationSec: number;
  volume: number;
  parameters: Record<string, SceneParameter>;
  instructions: string;
  published: boolean;
  updatedAt: number;
  /** Saved unpublished revision of an existing live scene. */
  draftOf?: string;
}
export interface DonationSceneLevel {
  id: string;
  name: string;
  minAmount: number;
  sceneId: string;
}
export interface EventStudioSettings {
  enabled: boolean;
  scenes: EventScene[];
  bindings: Partial<Record<AlertType, string>>;
  donationLevels: DonationSceneLevel[];
  giftMergeWindowSec: number;
}
export interface SceneEventData {
  id: string;
  type: AlertType;
  user: string;
  amount: number;
  currency: string;
  message: string;
  count: number;
  viewers: number;
  months: number;
  tier: string;
  anonymous: boolean;
  source: string;
}
export interface ScenePlayback {
  document: EventScene;
  event: SceneEventData;
}
export interface ScenePreviewOptions {
  preview?: boolean;
  mediaBaseUrl?: string;
  playbackId?: string;
  muted?: boolean;
}

export const SCENE_EVENT_TYPES: readonly AlertType[] = ['follow', 'sub', 'resub', 'giftsub', 'cheer', 'raid', 'donation', 'redemption'];
export const SCENE_MAX_CODE_LENGTH = 200_000;
export const SCENE_MAX_COUNT = 100;

export function defaultEventStudio(): EventStudioSettings {
  return { enabled: false, scenes: [], bindings: {}, donationLevels: [], giftMergeWindowSec: 1.5 };
}

export function sceneEventData(event: StreamEvent): SceneEventData {
  return {
    id: event.id, type: event.type, user: event.userName, source: event.source,
    amount: event.type === 'donation' ? event.amount : event.type === 'cheer' ? event.bits : 0,
    currency: event.type === 'donation' ? event.currency : '',
    message: 'message' in event ? event.message : event.type === 'redemption' ? event.input : '',
    count: event.type === 'giftsub' ? event.count : 1,
    viewers: event.type === 'raid' ? event.viewers : 0,
    months: event.type === 'resub' ? event.months : 0,
    tier: 'tier' in event ? event.tier : '',
    anonymous: 'anonymous' in event ? event.anonymous : false,
  };
}

export function newEventScene(eventType: EventScene['eventType'] = 'donation', lang: Language = 'ru'): EventScene {
  const ru = lang === 'ru';
  return {
    id: `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: ru ? 'Новая сцена' : 'New scene', eventType,
    html: '<main class="card"><div class="badge" data-field="type"></div><h1 data-field="user"></h1><strong><span data-field="amount"></span> <span data-field="currency"></span></strong><p data-field="message"></p></main>',
    css: 'body{display:grid;place-items:center;font-family:Segoe UI,sans-serif;color:white}.card{max-width:850px;padding:48px 64px;border:1px solid #ffffff40;border-radius:32px;background:linear-gradient(135deg,#211744ed,#101827ed);box-shadow:0 0 90px #9b6bff55;text-align:center;animation:arrive .7s both}.badge{color:#c9b4ff;text-transform:uppercase;letter-spacing:.2em}h1{font-size:64px;margin:16px 0}strong{font-size:42px;color:#c5adff}p{font-size:28px;overflow-wrap:anywhere}@keyframes arrive{from{opacity:0;transform:translateY(50px) scale(.85)}to{opacity:1;transform:none}}',
    js: "// scene.event and scene.params are available to every scene.\nconst card=document.querySelector('.card');\nif(scene.params.image){const img=document.createElement('img');img.src=scene.mediaUrl(scene.params.image);img.style.cssText='max-width:260px;max-height:220px;object-fit:contain';card.prepend(img);}\nif(scene.params.sound){const audio=new Audio(scene.mediaUrl(scene.params.sound));void audio.play().catch(()=>{});}\n",
    width: 1920, height: 1080, durationSec: 10, volume: 0.7,
    parameters: { accent: '#9b6bff' }, instructions: '', published: false, updatedAt: Date.now(),
  };
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown, fallback: number, min: number, max: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** Strict on authored source; tolerant defaults for optional fields and older records. */
export function normalizeEventScene(value: unknown): EventScene {
  const v = record(value);
  if (typeof v.id !== 'string' || !/^[\w-]{1,100}$/.test(v.id)) throw new Error('Invalid scene id');
  for (const field of ['html', 'css', 'js'] as const) {
    if (typeof v[field] !== 'string' || v[field].length > SCENE_MAX_CODE_LENGTH) throw new Error(`Invalid scene ${field} (maximum ${SCENE_MAX_CODE_LENGTH} characters)`);
  }
  const parameters: Record<string, SceneParameter> = {};
  const entries = Object.entries(record(v.parameters));
  if (entries.length > 60) throw new Error('Too many scene parameters (maximum 60)');
  for (const [key, item] of entries) {
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) throw new Error('Invalid scene parameter name');
    if (typeof item === 'string' && item.length <= 2000 || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) parameters[key] = item as SceneParameter;
    else throw new Error(`Invalid scene parameter: ${key}`);
  }
  return {
    id: v.id, name: typeof v.name === 'string' ? v.name.trim().slice(0, 100) || 'Scene' : 'Scene',
    eventType: SCENE_EVENT_TYPES.includes(v.eventType as AlertType) ? v.eventType as AlertType : 'any',
    html: v.html as string, css: v.css as string, js: v.js as string,
    width: Math.round(finite(v.width, 1920, 320, 3840)), height: Math.round(finite(v.height, 1080, 180, 2160)),
    durationSec: finite(v.durationSec, 10, 1, 120), volume: finite(v.volume, 0.7, 0, 1),
    parameters, instructions: typeof v.instructions === 'string' ? v.instructions.slice(0, 12_000) : '',
    published: v.published === true, updatedAt: finite(v.updatedAt, 0, 0, Number.MAX_SAFE_INTEGER),
    ...(typeof v.draftOf === 'string' && /^[\w-]{1,100}$/.test(v.draftOf) && v.draftOf !== v.id ? { draftOf: v.draftOf } : {}),
  };
}

/** Migration reads never discard other alert settings, even if a scene is malformed. */
export function normalizeEventStudio(value: unknown): EventStudioSettings {
  const v = record(value);
  const scenes: EventScene[] = [];
  for (const raw of (Array.isArray(v.scenes) ? v.scenes : []).slice(0, SCENE_MAX_COUNT)) {
    try { const scene = normalizeEventScene(raw); if (!scenes.some((s) => s.id === scene.id)) scenes.push(scene); } catch { /* keep valid scenes */ }
  }
  const bindings: EventStudioSettings['bindings'] = {};
  const source = record(v.bindings);
  for (const type of SCENE_EVENT_TYPES) if (typeof source[type] === 'string') bindings[type] = source[type] as string;
  const donationLevels: DonationSceneLevel[] = [];
  for (const raw of (Array.isArray(v.donationLevels) ? v.donationLevels : []).slice(0, 50)) {
    const level = record(raw);
    if (typeof level.id !== 'string' || typeof level.sceneId !== 'string' || typeof level.minAmount !== 'number' || !Number.isFinite(level.minAmount) || level.minAmount < 0 || donationLevels.some((l) => l.id === level.id)) continue;
    donationLevels.push({ id: level.id.slice(0, 100), name: typeof level.name === 'string' ? level.name.slice(0, 100) : '', minAmount: level.minAmount, sceneId: level.sceneId });
  }
  return { enabled: v.enabled === true, scenes, bindings, donationLevels, giftMergeWindowSec: finite(v.giftMergeWindowSec, 1.5, 0, 5) };
}

export function selectEventScene(studio: EventStudioSettings | undefined, event: StreamEvent, mainAmount: number | null): EventScene | null {
  if (!studio?.enabled) return null;
  const valid = (id: string | undefined) => studio.scenes.find((s) => s.id === id && s.published && (s.eventType === 'any' || s.eventType === event.type));
  if (event.type === 'donation' && mainAmount !== null) {
    const level = [...studio.donationLevels].filter((l) => Number.isFinite(l.minAmount) && l.minAmount <= mainAmount && !!valid(l.sceneId)).sort((a, b) => b.minAmount - a.minAmount)[0];
    if (level) return valid(level.sceneId)!;
  }
  return valid(studio.bindings[event.type]) ?? null;
}

export function normalizeSceneEvent(value: unknown, scene: EventScene): SceneEventData {
  const v = record(value);
  const text = (key: string, fallback = '') => typeof v[key] === 'string' ? (v[key] as string).slice(0, key === 'message' ? 4000 : 150) : fallback;
  return { id: text('id', `preview-${Date.now()}`), type: SCENE_EVENT_TYPES.includes(v.type as AlertType) ? v.type as AlertType : scene.eventType === 'any' ? 'donation' : scene.eventType,
    user: text('user', 'StreamHelper'), amount: finite(v.amount, 500, 0, 1e12), currency: text('currency', 'RUB'), message: text('message'),
    count: Math.round(finite(v.count, 10, 1, 100_000)), viewers: Math.round(finite(v.viewers, 100, 0, 1e8)), months: Math.round(finite(v.months, 12, 0, 10_000)),
    tier: text('tier', '1000'), anonymous: v.anonymous === true, source: text('source', 'test') };
}

/** JSON never becomes markup. Viewer names/messages can contain arbitrary HTML safely. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Both live OBS and the editor load this document in an opaque sandbox frame. */
export function buildSceneDocument(input: EventScene, event: SceneEventData, options: ScenePreviewOptions = {}): string {
  const scene = normalizeEventScene(input);
  let origin = '';
  try { const url = new URL(options.mediaBaseUrl ?? ''); if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) origin = url.origin; } catch { /* no local assets */ }
  const assets = origin ? `${origin}/media/ ${origin}/overlay/assets/` : '';
  const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https: ${assets}; media-src data: blob: https: ${assets}; font-src data: ${assets}; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;
  const payload = { html: scene.html, css: scene.css, js: scene.js, event: normalizeSceneEvent(event, scene), parameters: scene.parameters,
    preview: !!options.preview, muted: options.muted ?? !!options.preview, durationMs: scene.durationSec * 1000, volume: scene.volume,
    playbackId: options.playbackId ?? event.id, width: scene.width, height: scene.height, mediaBaseUrl: origin };
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}*{box-sizing:border-box}#scene-root{display:contents}</style></head><body><div id="scene-root"></div><script>
(() => {
const p=${scriptJson(payload)};
const report=(kind,message)=>parent.postMessage({type:'scene:runtime',playbackId:p.playbackId,kind,message},'*');
addEventListener('error',e=>report('error',String(e.message||'Scene script error').slice(0,1000)));
addEventListener('unhandledrejection',e=>report('error',String(e.reason?.message||e.reason||'Unhandled scene promise').slice(0,1000)));
const root=document.getElementById('scene-root');
const ownedMedia=new Set(),audioContexts=new Set();
const prepareMedia=m=>{ownedMedia.add(m);m.muted=p.muted;m.volume=p.muted?0:p.volume;};
const nativePlay=HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play=function(...args){prepareMedia(this);return nativePlay.apply(this,args);};
const NativeAudio=window.Audio;
window.Audio=function(...args){const audio=new NativeAudio(...args);prepareMedia(audio);return audio;};window.Audio.prototype=NativeAudio.prototype;
const NativeContext=window.AudioContext||window.webkitAudioContext;
if(NativeContext){const ControlledContext=class extends NativeContext{constructor(...args){super(...args);const destination=this.destination,master=this.createGain();master.gain.value=p.muted?0:p.volume;master.connect(destination);Object.defineProperty(this,'destination',{value:master});audioContexts.add(this);}};window.AudioContext=ControlledContext;if(window.webkitAudioContext)window.webkitAudioContext=ControlledContext;}
root.innerHTML=p.html;
const style=document.createElement('style'); style.textContent=p.css; document.head.appendChild(style);
let finished=false;
const updateHandlers=new Set();
const api={event:p.event,params:p.parameters,preview:p.preview,durationMs:p.durationMs,width:p.width,height:p.height,mediaBaseUrl:p.mediaBaseUrl,
mediaUrl(name){if(typeof name!=='string'||!name)return '';if(/^(https:|data:|blob:)/i.test(name))return name;if(name.startsWith('/media/'))return p.mediaBaseUrl+name;return p.mediaBaseUrl+'/media/'+name.split('/').map(encodeURIComponent).join('/');},
finish(){if(finished)return;finished=true;root.style.display='none';for(const m of ownedMedia)m.pause();for(const ctx of audioContexts)void ctx.close();report('finished');},
onUpdate(fn){if(typeof fn!=='function')return ()=>{};updateHandlers.add(fn);return ()=>updateHandlers.delete(fn);}};
Object.defineProperty(window,'scene',{value:api,writable:false});
for(const [key,value] of Object.entries(p.parameters)){if(typeof value==='string'&&/^#[0-9a-f]{3,8}$/i.test(value))document.documentElement.style.setProperty('--'+key,value);}
const fields=()=>root.querySelectorAll('[data-field]').forEach(el=>{const k=el.getAttribute('data-field');const v=Object.hasOwn(api.event,k)?api.event[k]:Object.hasOwn(api.params,k)?api.params[k]:'';el.textContent=String(v??'');});
fields();
const media=()=>document.querySelectorAll('audio,video').forEach(m=>{prepareMedia(m);if(p.mediaBaseUrl&&m.getAttribute('src')?.startsWith('/media/'))m.src=p.mediaBaseUrl+m.getAttribute('src');});
root.querySelectorAll('[src]').forEach(el=>{const src=el.getAttribute('src');if(p.mediaBaseUrl&&src?.startsWith('/media/'))el.setAttribute('src',p.mediaBaseUrl+src);});
media();new MutationObserver(media).observe(root,{childList:true,subtree:true});
addEventListener('message',e=>{if(e.source!==parent||e.data?.type!=='scene:update'||e.data.playbackId!==p.playbackId)return;Object.assign(api.event,e.data.event);fields();for(const fn of updateHandlers){try{fn(api.event);}catch(err){report('error',String(err?.message||err));}}});
const script=document.createElement('script');script.textContent=p.js;document.body.appendChild(script);
setTimeout(()=>api.finish(),p.durationMs);report('ready');
})();<\/script></body></html>`;
}

export function scenePresets(lang: Language = 'ru'): EventScene[] {
  const ru = lang === 'ru';
  const donation = newEventScene('donation', lang);
  donation.name = ru ? 'Донат · Световая карточка' : 'Donation · Light card';
  const epic = { ...newEventScene('donation', lang), name: ru ? 'Донат · Сверхновая' : 'Donation · Supernova', durationSec: 14 };
  epic.html = `<div class="nebula"></div><div class="rings"></div><main><small>${ru ? 'НОВАЯ ЗВЕЗДА ЭФИРА' : 'A NEW STAR ON STREAM'}</small><h1 data-field="user"></h1><div class="amount"><span data-field="amount"></span> <span data-field="currency"></span></div><p data-field="message"></p></main>`;
  epic.css = 'body{display:grid;place-items:center;color:#fff;font-family:Segoe UI,sans-serif;text-align:center}.nebula{position:absolute;inset:5%;background:radial-gradient(ellipse,#ba69ff88,transparent 60%);animation:glow 2s infinite alternate}.rings{width:700px;height:700px;border:2px solid #eacbff88;border-radius:50%;position:absolute;box-shadow:0 0 60px #d898ff88,inset 0 0 70px #9b6bff88;animation:spin 9s linear infinite}.rings:after{content:"";position:absolute;inset:60px;border:1px dashed #e4beff;border-radius:50%}main{position:relative;max-width:1000px;animation:appear 1s both}small{letter-spacing:.45em;color:#e1bfff;font-size:24px}h1{font-size:84px;margin:20px}.amount{font-size:100px;font-weight:900;text-shadow:0 0 35px #ca8eff}p{font-size:30px;overflow-wrap:anywhere}@keyframes glow{to{transform:scale(1.2);opacity:.6}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes appear{from{opacity:0;transform:scale(.7)}}';
  const gift = { ...newEventScene('giftsub', lang), name: ru ? 'Подарки · Общая распаковка' : 'Gifts · Unboxing', durationSec: 14 };
  gift.html = `<main><small>${ru ? 'ПОДАРОЧНЫЕ ПОДПИСКИ' : 'GIFT SUBSCRIPTIONS'}</small><h1><span data-field="user"></span> × <span data-field="count"></span></h1><div id="gifts"></div><p>${ru ? 'Добро пожаловать в команду!' : 'Welcome to the team!'}</p></main>`;
  gift.css = 'body{display:grid;place-items:center;font-family:Segoe UI,sans-serif;color:white;text-align:center}main{width:1100px;padding:40px;border-radius:40px;background:radial-gradient(ellipse at top,#6636a5e8,#121627ed);border:1px solid #d6b4ff66;box-shadow:0 0 100px #9866ff44}small{font-size:22px;letter-spacing:.35em;color:#ddc7ff}h1{font-size:62px;margin:20px}#gifts{display:flex;flex-wrap:wrap;justify-content:center;gap:14px;max-height:500px;overflow:hidden}.gift{width:85px;height:85px;border-radius:18px;background:linear-gradient(135deg,#d8b8ff,#8651e7);display:grid;place-items:center;font-size:48px;box-shadow:0 8px 24px #0004;animation:unwrap .8s both;animation-delay:var(--delay)}p{font-size:28px;color:#e4d8ff}@keyframes unwrap{from{opacity:0;transform:translateY(70px) rotate(-20deg) scale(.2)}70%{transform:translateY(-10px) rotate(5deg) scale(1.1)}to{opacity:1;transform:none}}';
  gift.js = "const tray=document.getElementById('gifts');for(let i=0;i<Math.min(48,scene.event.count);i++){const el=document.createElement('div');el.className='gift';el.textContent='🎁';el.style.setProperty('--delay',(i*.09)+'s');tray.append(el);}";
  const raid = { ...newEventScene('raid', lang), name: ru ? 'Рейд · Звёздные врата' : 'Raid · Stargate', durationSec: 15 };
  raid.html = `<div class="portal"></div><div id="fleet"></div><main><small>${ru ? 'ПРИБЫВАЕТ РЕЙД' : 'INCOMING RAID'}</small><h1 data-field="user"></h1><div><b data-field="viewers"></b> ${ru ? 'зрителей с нами' : 'viewers joining us'}</div><p>${ru ? 'Устраивайтесь поудобнее. Добро пожаловать!' : 'Make yourself at home. Welcome!'}</p></main>`;
  raid.css = 'body{display:grid;place-items:center;font-family:Segoe UI,sans-serif;color:white;text-align:center}.portal{position:absolute;width:680px;height:680px;border:8px solid #7ce6ff;border-radius:50%;box-shadow:0 0 80px #5f8fff,inset 0 0 100px #9463ff;background:radial-gradient(circle,#251a5888,transparent);animation:gate 2s infinite alternate}main{position:relative;max-width:1100px;text-shadow:0 4px 24px #000}small{font-size:24px;letter-spacing:.5em;color:#9deaff}h1{font-size:94px;margin:20px}main div{font-size:44px}p{font-size:28px;color:#d7e9ff}.ship{position:absolute;width:12px;height:30px;background:#a8edff;clip-path:polygon(50% 0,100% 100%,50% 75%,0 100%);filter:drop-shadow(0 0 10px #8adfff);animation:fly 4s infinite;animation-delay:var(--delay);left:var(--x);top:var(--y)}@keyframes gate{to{transform:scale(1.08);border-color:#c0a6ff}}@keyframes fly{from{opacity:0;transform:translateY(180px) scale(.2)}30%{opacity:1}to{opacity:0;transform:translateY(-240px) scale(1.6)}}';
  raid.js = "const fleet=document.getElementById('fleet');for(let i=0;i<Math.min(70,scene.event.viewers);i++){const el=document.createElement('i');el.className='ship';el.style.setProperty('--x',(10+(i*37%80))+'%');el.style.setProperty('--y',(20+(i*23%60))+'%');el.style.setProperty('--delay',(i*.055)+'s');fleet.append(el);}";
  raid.css += '#fleet{position:absolute;inset:0;pointer-events:none}';
  return [donation, epic, gift, raid];
}
