/**
 * Tiny template language used by alerts, bot commands and timers.
 *
 *   "{user} donated {amount} {currency}"   -> plain variables
 *   "{count:deaths}" / "{random:1-100}"    -> variable with an argument
 *
 * Unknown variables are left as-is so typos stay visible to the streamer.
 */
export type TemplateResolver = (name: string, arg: string | undefined) => string | number | undefined;

const TOKEN = /\{([a-zA-Z_][\w+]*)(?::([^{}]*))?\}/g;

export function renderTemplate(template: string, vars: Record<string, string | number> | TemplateResolver): string {
  const resolve: TemplateResolver = typeof vars === 'function' ? vars : (name) => vars[name];
  return template.replace(TOKEN, (whole, name: string, arg: string | undefined) => {
    const value = resolve(name, arg);
    return value === undefined ? whole : String(value);
  });
}

/** Async variant: resolvers may hit the network (e.g. {followage}). */
export async function renderTemplateAsync(
  template: string,
  resolve: (name: string, arg: string | undefined) => Promise<string | number | undefined> | string | number | undefined,
): Promise<string> {
  const matches = [...template.matchAll(TOKEN)];
  if (matches.length === 0) return template;
  const values = await Promise.all(matches.map((m) => resolve(m[1], m[2])));
  let out = '';
  let last = 0;
  matches.forEach((m, i) => {
    out += template.slice(last, m.index) + (values[i] === undefined ? m[0] : String(values[i]));
    last = m.index! + m[0].length;
  });
  return out + template.slice(last);
}

export function formatDuration(ms: number, lang: 'ru' | 'en' = 'ru'): string {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const u = lang === 'ru' ? { d: 'д', h: 'ч', m: 'мин' } : { d: 'd', h: 'h', m: 'm' };
  const parts: string[] = [];
  if (d) parts.push(`${d}${u.d}`);
  if (h) parts.push(`${h}${u.h}`);
  if (m || parts.length === 0) parts.push(`${m}${u.m}`);
  return parts.join(' ');
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function tierLabel(tier: '1000' | '2000' | '3000'): string {
  return tier === '3000' ? '3' : tier === '2000' ? '2' : '1';
}
