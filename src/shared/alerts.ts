import { donationAmount, eventAmount, eventVars } from './events';
import { renderTemplate } from './template';
import type { AlertSettings, AlertType, RenderedAlert, StreamEvent } from './types';

export function mediaUrl(name: string | null): string | null {
  return name ? `/media/${encodeURIComponent(name)}` : null;
}

/** Turn an event into what the alert overlay shows. Returns null if this alert is disabled or below threshold. */
export function renderAlert(e: StreamEvent, settings: AlertSettings, mainCurrency = e.type === 'donation' ? e.currency : ''): RenderedAlert | null {
  const amount = e.type === 'donation' ? donationAmount(e, mainCurrency) : eventAmount(e);
  const tier = e.type === 'donation' && amount !== null
    ? [...(settings.donationTiers ?? [])]
        .filter((item) => Number.isFinite(item.minAmount) && item.minAmount <= amount)
        .sort((a, b) => b.minAmount - a.minAmount)[0]
    : undefined;
  const v = tier?.variant ?? settings.types[e.type];
  if (!v?.enabled) return null;
  if (v.minAmount > 0 && (amount === null || amount < v.minAmount)) return null;
  const vars = eventVars(e);
  return {
    id: e.id,
    type: e.type,
    title: renderTemplate(v.title, vars),
    message: renderTemplate(v.message, vars),
    userName: e.userName,
    durationSec: v.durationSec,
    sound: mediaUrl(v.sound),
    volume: v.volume,
    image: mediaUrl(v.image),
    animation: v.animation,
    tts: v.tts,
    style: tier?.style ?? settings.style,
  };
}

let testSeq = 0;

/** A realistic sample event for the "Test" buttons. */
export function sampleEvent(type: AlertType, lang: 'ru' | 'en', currency: string, donationAmount?: number): StreamEvent {
  const base = { id: `test_${Date.now().toString(36)}_${testSeq++}`, source: 'test' as const, timestamp: Date.now(), userName: 'StreamHelper' };
  const msg = lang === 'ru' ? 'Это тестовое сообщение. Отличный стрим!' : 'This is a test message. Great stream!';
  switch (type) {
    case 'follow':
      return { ...base, type };
    case 'sub':
      return { ...base, type, tier: '1000', isPrime: false };
    case 'resub':
      return { ...base, type, tier: '1000', months: 12, streak: 6, message: msg };
    case 'giftsub':
      return { ...base, type, tier: '1000', count: 5, anonymous: false };
    case 'cheer':
      return { ...base, type, bits: 500, message: msg, anonymous: false };
    case 'raid':
      return { ...base, type, viewers: 42 };
    case 'donation':
      return { ...base, type, amount: donationAmount ?? (currency === 'RUB' ? 500 : 10), currency, message: msg };
    case 'redemption':
      return { ...base, type, rewardTitle: lang === 'ru' ? 'Выпить воды' : 'Hydrate', cost: 1000, input: '' };
  }
}
