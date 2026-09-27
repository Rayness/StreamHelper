import { describe, expect, it } from 'vitest';
import { chooseMusicCandidate, musicSourceKind } from '../src/main/features/music';

describe('Windows music session selection', () => {
  it('recognizes Spotify, Yandex Music and browser sessions', () => {
    expect(musicSourceKind('Spotify.exe')).toBe('spotify');
    expect(musicSourceKind('YandexMusic.exe')).toBe('yandex');
    expect(musicSourceKind('Chrome')).toBe('browser');
    expect(musicSourceKind('SomePlayer.exe')).toBe('other');
  });

  it('prefers active playback before the service priority', () => {
    const sessions = [
      { kind: 'spotify' as const, playing: false },
      { kind: 'browser' as const, playing: true },
    ];
    expect(chooseMusicCandidate(sessions, 'auto')).toBe(sessions[1]);
  });

  it('prefers Spotify then Yandex among active sessions', () => {
    const sessions = [
      { kind: 'browser' as const, playing: true },
      { kind: 'yandex' as const, playing: true },
      { kind: 'spotify' as const, playing: true },
    ];
    expect(chooseMusicCandidate(sessions, 'auto')).toBe(sessions[2]);
    expect(chooseMusicCandidate(sessions, 'yandex')).toBe(sessions[1]);
    expect(chooseMusicCandidate(sessions, 'other')).toBeNull();
  });
});
