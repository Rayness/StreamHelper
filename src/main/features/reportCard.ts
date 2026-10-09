import type { ClipReason, Language, ReportSettings, ReportSummary } from '@shared/types';

export const REPORT_WIDTH = 1200;
export const REPORT_HEIGHT = 675;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function duration(ms: number, ru: boolean): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return ru ? `${h ? `${h} ч ` : ''}${m} мин` : `${h ? `${h}h ` : ''}${m}m`;
}

function clock(at: number, ru: boolean): string {
  return new Date(at).toLocaleTimeString(ru ? 'ru-RU' : 'en-US', { hour: '2-digit', minute: '2-digit' });
}

function n(v: number, ru: boolean): string {
  return v.toLocaleString(ru ? 'ru-RU' : 'en-US', { maximumFractionDigits: 2 });
}

/** Russian plural: plural(5, ['рейд', 'рейда', 'рейдов']). */
function plural(v: number, forms: [string, string, string]): string {
  const m10 = v % 10;
  const m100 = v % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
  return forms[2];
}

const REASON: Record<ClipReason, [string, string]> = { burst: ['взрыв чата', 'chat burst'], keywords: ['реакция чата', 'chat reaction'], vote: ['зрители попросили', 'viewers asked'], manual: ['клип стримера', "streamer's pick"] };

/** Short text version for chat and Discord. */
export function reportText(s: ReportSummary, lang: Language): string {
  const ru = lang === 'ru';
  const parts = [
    ru ? `📊 Итоги стрима (${duration((s.endedAt ?? Date.now()) - s.startedAt, ru)})` : `📊 Stream recap (${duration((s.endedAt ?? Date.now()) - s.startedAt, ru)})`,
    ru ? `пик ${s.peakViewers} зрит.` : `peak ${s.peakViewers} viewers`,
    ru ? `${s.messages} сообщений от ${s.chatters} чел.` : `${s.messages} messages from ${s.chatters} chatters`,
  ];
  if (s.mvp[0]) parts.push(`MVP: ${s.mvp[0].name}`);
  if (s.follows) parts.push(ru ? `+${s.follows} фолловеров` : `+${s.follows} followers`);
  if (s.subs + s.gifts) parts.push(ru ? `${s.subs + s.gifts} подписок` : `${s.subs + s.gifts} subs`);
  if (s.topWord) parts.push(ru ? `слово стрима: «${s.topWord.word}»` : `word of the stream: "${s.topWord.word}"`);
  return parts.join(' · ');
}

/**
 * The end-of-stream card as a self-contained HTML page (system fonts, no network), rendered to PNG
 * by an offscreen window. Emote images are the only remote content and are optional.
 */
export function reportHtml(s: ReportSummary, cfg: Pick<ReportSettings, 'accentColor'>, lang: Language, channel: string): string {
  const ru = lang === 'ru';
  const t = (r: string, e: string) => (ru ? r : e);
  const word = (v: number, forms: [string, string, string], en: string) => (ru ? plural(v, forms) : en);
  const accent = /^#[0-9a-f]{6}$/i.test(cfg.accentColor) ? cfg.accentColor : '#9b6bff';
  const end = s.endedAt ?? Date.now();
  const date = new Date(s.startedAt).toLocaleDateString(ru ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  const tile = (value: string, label: string) => `<div class="tile"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const support: string[] = [];
  if (s.follows) support.push(tile(`+${n(s.follows, ru)}`, word(s.follows, ['фолловер', 'фолловера', 'фолловеров'], 'followers')));
  if (s.subs + s.gifts) support.push(tile(n(s.subs + s.gifts, ru), word(s.subs + s.gifts, ['подписка', 'подписки', 'подписок'], 'subs')));
  if (s.bits) support.push(tile(n(s.bits, ru), word(s.bits, ['битс', 'битса', 'битсов'], 'bits')));
  if (s.donations) support.push(tile(`${n(s.donations, ru)} ${s.currency}`, t('донатами', 'donated')));
  if (s.raids.length) support.push(tile(String(s.raids.length), word(s.raids.length, ['рейд', 'рейда', 'рейдов'], s.raids.length === 1 ? 'raid' : 'raids')));
  const mvp = s.mvp.map((m, i) => `<li><span class="rank">${['🥇', '🥈', '🥉'][i]}</span><span class="who" style="color:${/^#[0-9a-f]{6}$/i.test(m.color ?? '') ? m.color : '#fff'}">${esc(m.name)}</span><span class="muted">${n(m.messages, ru)}</span></li>`).join('');
  const highlights: string[] = [];
  if (s.topWord) highlights.push(`<div class="hl"><span class="k">${t('Слово стрима', 'Word of the stream')}</span><b>«${esc(s.topWord.word)}»</b><span class="muted">×${n(s.topWord.count, ru)}</span></div>`);
  if (s.topEmote) highlights.push(`<div class="hl"><span class="k">${t('Смайл стрима', 'Emote of the stream')}</span><b class="emote"><img src="${esc(s.topEmote.url)}" alt=""> ${esc(s.topEmote.name)}</b><span class="muted">×${n(s.topEmote.count, ru)}</span></div>`);
  if (s.topDonation) highlights.push(`<div class="hl"><span class="k">${t('Топ донат', 'Top donation')}</span><b>${esc(s.topDonation.name)}</b><span class="muted">${n(s.topDonation.amount, ru)} ${esc(s.topDonation.currency)}</span></div>`);
  if (s.bestClip) highlights.push(`<div class="hl"><span class="k">${t('Лучший момент', 'Best moment')}</span><b>${esc(REASON[s.bestClip.reason][ru ? 0 : 1])}</b><span class="muted">${clock(s.bestClip.at, ru)} · ${esc(s.bestClip.url.replace(/^https?:\/\//, ''))}</span></div>`);
  const drama = s.drama
    ? `<div class="drama"><span class="k">🔥 ${t('Главная драма вечера', 'Drama of the night')} · ${clock(s.drama.at, ru)} · ${n(s.drama.messages, ru)} ${t('сообщ./мин', 'msg/min')}</span>${s.drama.quote ? `<q>${esc(s.drama.quote.text)}</q><span class="muted">— ${esc(s.drama.quote.user)}</span>` : ''}</div>`
    : '';
  return `<!doctype html><html lang="${ru ? 'ru' : 'en'}"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${REPORT_WIDTH}px;height:${REPORT_HEIGHT}px;overflow:hidden}
body{font-family:"Segoe UI",system-ui,sans-serif;color:#fff;background:#0e0c15;position:relative}
.bg{position:absolute;inset:0;background:radial-gradient(900px 500px at 105% -10%,${accent}55,transparent 60%),radial-gradient(700px 420px at -10% 110%,${accent}33,transparent 60%)}
.wrap{position:relative;display:grid;grid-template-columns:1.25fr 1fr;gap:28px;padding:44px 52px;height:100%}
.eyebrow{color:${accent};font-weight:800;letter-spacing:.14em;text-transform:uppercase;font-size:15px}
h1{font-size:40px;line-height:1.1;font-weight:800;margin:10px 0 6px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.sub{color:#cfc8de;font-size:18px}
.big{display:flex;gap:16px;margin:26px 0 18px}
.big .tile{flex:1;background:#ffffff10;border:1px solid #ffffff1c;border-radius:16px;padding:16px 18px}
.tile b{display:block;font-size:34px;font-weight:800;font-variant-numeric:tabular-nums}
.tile span{color:#bdb5cf;font-size:15px}
.support{display:flex;flex-wrap:wrap;gap:10px}
.support .tile{background:${accent}22;border-radius:12px;padding:10px 14px}
.support .tile b{font-size:22px}
.drama{margin-top:22px;padding:16px 18px;border-left:4px solid ${accent};background:#ffffff0c;border-radius:0 14px 14px 0}
.drama q{display:block;font-size:21px;font-weight:600;margin:8px 0 4px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.k{display:block;color:#bdb5cf;font-size:14px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.side{display:flex;flex-direction:column;gap:14px}
.card{background:#ffffff0d;border:1px solid #ffffff1a;border-radius:18px;padding:18px 20px}
ol{list-style:none;margin-top:10px}
li{display:flex;align-items:center;gap:12px;font-size:21px;padding:6px 0}
.who{flex:1;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.muted{color:#a79fba;font-size:16px}
.hl{display:grid;grid-template-columns:1fr auto;align-items:baseline;gap:2px 10px;padding:10px 0;border-top:1px solid #ffffff14}
.hl:first-child{border-top:0;padding-top:0}
.hl .k{grid-column:1/3}
.hl b{font-size:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.emote img{height:28px;vertical-align:-6px}
.foot{position:absolute;left:52px;right:52px;bottom:22px;display:flex;justify-content:space-between;color:#8d859f;font-size:14px}
</style></head><body><div class="bg"></div><div class="wrap">
<section>
<span class="eyebrow">${t('Итоги стрима', 'Stream recap')} · ${esc(date)}</span>
<h1>${esc(s.title || t('Трансляция', 'Stream'))}</h1>
<p class="sub">${esc(s.category || '')}${s.category ? ' · ' : ''}${duration(end - s.startedAt, ru)}${channel ? ` · twitch.tv/${esc(channel)}` : ''}</p>
<div class="big">${tile(n(s.peakViewers, ru), t('пик зрителей', 'peak viewers'))}${tile(n(s.messages, ru), word(s.messages, ['сообщение', 'сообщения', 'сообщений'], 'messages'))}${tile(n(s.chatters, ru), t('в чате', 'chatters'))}</div>
${support.length ? `<div class="support">${support.join('')}</div>` : ''}
${drama}
</section>
<aside class="side">
<div class="card"><span class="k">MVP ${t('чата', 'of chat')}</span><ol>${mvp || `<li class="muted">${t('Чат молчал', 'Chat was quiet')}</li>`}</ol></div>
${highlights.length ? `<div class="card">${highlights.join('')}</div>` : ''}
</aside>
</div><div class="foot"><span>${t('Средний онлайн', 'Average viewers')}: ${n(s.avgViewers, ru)}${s.clips ? ` · ${t('моментов', 'moments')}: ${s.clips}` : ''}</span><span>StreamHelper</span></div></body></html>`;
}
