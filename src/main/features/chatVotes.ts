import type { RuntimeState } from '@shared/types';

export type NumberVote = 'poll' | 'duel' | 'curse';

/** Polls, music duels and curse votes all read "1", "2"… from chat: only one may listen at a time. */
export function runningNumberVote(state: RuntimeState): NumberVote | null {
  if (state.poll?.status === 'running') return 'poll';
  if (state.duel.status === 'playingA' || state.duel.status === 'playingB' || state.duel.status === 'voting') return 'duel';
  if (state.curse.status === 'voting') return 'curse';
  return null;
}

/** Throws when another number vote is running in chat (`own` is the caller, which may restart itself). */
export function assertNoOtherNumberVote(state: RuntimeState, own: NumberVote, ru: boolean): void {
  const running = runningNumberVote(state);
  if (!running || running === own) return;
  const name = {
    poll: ru ? 'опрос' : 'a poll',
    duel: ru ? 'музыкальная дуэль' : 'a music duel',
    curse: ru ? 'выбор проклятия' : 'a curse vote',
  }[running];
  throw new Error(ru ? `В чате уже идёт голосование цифрами: ${name}. Дождитесь конца.` : `Chat is already voting with numbers: ${name}. Wait for it to end.`);
}
