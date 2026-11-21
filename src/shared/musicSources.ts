import type { MusicSourceKind, SongRequest } from './types';

export const MUSIC_SOURCES = ['spotify', 'yandex', 'youtubeMusic', 'youtube', 'browser', 'other'] as const satisfies readonly MusicSourceKind[];

export function isMusicSource(value: unknown): value is MusicSourceKind {
  return MUSIC_SOURCES.some((source) => source === value);
}

export function youtubeMusicLink(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname === 'music.youtube.com';
  } catch {
    return false;
  }
}

export function youtubeTrackUrl(videoId: string, provider?: SongRequest['provider'], listId?: string): string {
  const domain = provider === 'youtubeMusic' ? 'music.youtube.com' : 'www.youtube.com';
  const params = new URLSearchParams();
  if (videoId) params.set('v', videoId);
  if (listId) params.set('list', listId);
  return `https://${domain}/${videoId ? 'watch' : 'playlist'}?${params}`;
}
