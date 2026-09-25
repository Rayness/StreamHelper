import type { HelixClient } from './helix';

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/** Loads 7TV, BTTV and FFZ emotes (global + channel). Failures of one provider don't affect others. */
export async function loadThirdPartyEmotes(twitchUserId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const add = (name: string | undefined, url: string | undefined) => {
    if (name && url) map.set(name, url);
  };

  const sources: Promise<void>[] = [
    // BTTV
    getJson('https://api.betterttv.net/3/cached/emotes/global').then((list: any[]) =>
      list.forEach((e) => add(e.code, `https://cdn.betterttv.net/emote/${e.id}/2x`)),
    ),
    getJson(`https://api.betterttv.net/3/cached/users/twitch/${twitchUserId}`).then((u: any) =>
      [...(u.channelEmotes ?? []), ...(u.sharedEmotes ?? [])].forEach((e) => add(e.code, `https://cdn.betterttv.net/emote/${e.id}/2x`)),
    ),
    // FFZ (through BTTV's cache, which normalizes the format)
    getJson('https://api.betterttv.net/3/cached/frankerfacez/emotes/global').then((list: any[]) =>
      list.forEach((e) => add(e.code, e.images?.['2x'] ?? e.images?.['1x'])),
    ),
    getJson(`https://api.betterttv.net/3/cached/frankerfacez/users/twitch/${twitchUserId}`).then((list: any[]) =>
      list.forEach((e) => add(e.code, e.images?.['2x'] ?? e.images?.['1x'])),
    ),
    // 7TV
    getJson('https://7tv.io/v3/emote-sets/global').then((set: any) => add7tv(set?.emotes, add)),
    getJson(`https://7tv.io/v3/users/twitch/${twitchUserId}`).then((u: any) => add7tv(u?.emote_set?.emotes, add)),
  ];
  const results = await Promise.allSettled(sources);
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed) console.info(`[emotes] ${failed} of ${results.length} emote sources unavailable (channel may not use them)`);
  return map;
}

function add7tv(emotes: any[] | undefined, add: (name: string, url: string) => void): void {
  for (const e of emotes ?? []) {
    const host = e.data?.host;
    if (host?.url) add(e.name, `https:${host.url}/2x.webp`);
  }
}

export type BadgeMap = Map<string, { imageUrl: string; title: string }>;

/** Global + channel chat badges, keyed "set_id/version". Channel badges override global ones. */
export async function loadBadges(helix: HelixClient, broadcasterId: string): Promise<BadgeMap> {
  const map: BadgeMap = new Map();
  const fill = (data: any[]) => {
    for (const set of data ?? []) {
      for (const v of set.versions ?? []) map.set(`${set.set_id}/${v.id}`, { imageUrl: v.image_url_2x, title: v.title });
    }
  };
  const [global, channel] = await Promise.allSettled([
    helix.get('/chat/badges/global'),
    helix.get('/chat/badges', { broadcaster_id: broadcasterId }),
  ]);
  if (global.status === 'fulfilled') fill(global.value.data);
  if (channel.status === 'fulfilled') fill(channel.value.data);
  return map;
}
