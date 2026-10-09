import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatMessage, MarketSettings, MarketState, OverlayMessage, StockQuote } from '@shared/types';
import type { AppContext } from '../core/context';
import { parseCommand } from '../bot/variables';
import type { StageDeps } from './stage';

interface Holding { qty: number; cost: number }

export interface Wallet {
  name: string;
  login: string;
  balance: number;
  holdings: Record<string, Holding>;
  lastEarnAt: number;
  lastChatAt: number;
}

export interface Stock {
  userId: string;
  name: string;
  login: string;
  price: number;
  /** Price at the start of the stream: "change" is measured from here. */
  open: number;
  history: number[];
  messages: number;
  tickMessages: number;
  /** Usual messages per tick (moving average). */
  avgActivity: number;
  lastChatAt: number;
  dividendTick: number;
  listed: boolean;
}

export interface MarketData {
  version: 1;
  tick: number;
  wallets: Record<string, Wallet>;
  stocks: Record<string, Stock>;
}

const HISTORY = 30;
const MAX_WALLETS = 3000;
const ACTIVE_MS = 10 * 60_000;
const REPLY_COOLDOWN_MS = 3000;
const NEWS_MOVE = 15;

export function emptyMarket(): MarketData {
  return { version: 1, tick: 0, wallets: {}, stocks: {} };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One market tick for a stock: more chat than usual pushes the price up, less pulls it down,
 * silence on a live stream costs `decayPct`, plus a little noise. Never below 1.
 */
export function nextPrice(stock: Pick<Stock, 'price' | 'tickMessages' | 'avgActivity'>, cfg: Pick<MarketSettings, 'volatility' | 'decayPct'>, live: boolean, rand: () => number = Math.random): { price: number; avg: number } {
  const act = stock.tickMessages;
  const avg = stock.avgActivity > 0 ? stock.avgActivity : Math.max(1, act);
  const signal = Math.tanh((act - avg) / (avg + 1));
  let change = cfg.volatility * signal + (rand() - 0.5) * (cfg.volatility / 2);
  if (act === 0 && live) change -= cfg.decayPct;
  const price = Math.max(1, round2(stock.price * (1 + change / 100)));
  return { price, avg: avg * 0.8 + act * 0.2 };
}

/** Price after a trade: buying lifts it, selling sinks it, by `impactPct` × √shares. */
export function priceAfterTrade(price: number, qty: number, impactPct: number, side: 'buy' | 'sell'): number {
  const move = (impactPct / 100) * Math.sqrt(Math.max(0, qty));
  return Math.max(1, round2(side === 'buy' ? price * (1 + move) : price / (1 + move)));
}

/**
 * What a trade actually pays per share: the average between the price before and after its own impact.
 * Filling at the old price would let a viewer buy (lifting the price) and sell straight back for a profit.
 */
export function fillPrice(price: number, qty: number, impactPct: number, side: 'buy' | 'sell'): number {
  return round2((price + priceAfterTrade(price, qty, impactPct, side)) / 2);
}

/** Most shares a balance can pay for, impact included. */
export function maxAffordable(price: number, balance: number, impactPct: number): number {
  let lo = 0;
  let hi = Math.max(0, Math.floor(balance / price));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (round2(fillPrice(price, mid, impactPct, 'buy') * mid) <= balance) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** "5", "все", "all", "max" → number of shares (null = not understood). */
export function parseQty(raw: string | undefined, max: number): number | null {
  if (raw === undefined) return 1;
  const t = raw.trim().toLowerCase();
  if (['все', 'всё', 'all', 'max', 'макс'].includes(t)) return Math.max(0, Math.floor(max));
  if (!/^\d{1,6}$/.test(t)) return null;
  return Number(t);
}

const FALLBACK = { market: ['market', 'биржа'], buy: ['buy', 'купить'], sell: ['sell', 'продать'], portfolio: ['portfolio', 'портфель'], balance: ['balance', 'баланс'], price: ['stock', 'акция', 'price'] } as const;

/**
 * Viewer stock exchange: every active chatter is a stock whose price follows how much they talk.
 * Viewers earn coins by chatting and trade each other's stocks with chat commands.
 * Stored in its own file: the economy is the channel's, not a profile's.
 */
export class MarketService {
  private data: MarketData;
  private saveTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private tickEvery = 0;
  private lastReply = new Map<string, number>();
  private activitySinceTick = false;
  private wasLive: boolean;

  constructor(
    private ctx: AppContext,
    private deps: StageDeps,
    private file: string,
    private rand: () => number = Math.random,
    private now: () => number = Date.now,
  ) {
    this.data = this.load();
    this.wasLive = ctx.state.current.stream.live;
    ctx.bus.on('chat:message', (m) => this.onChat(m));
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'market') { this.syncTimer(); this.publish(); }
      if (key === 'language') this.publish();
    });
    ctx.bus.on('stream:update', (stream) => {
      // A new stream: today's change starts from the current prices.
      if (stream.live && !this.wasLive) { for (const s of Object.values(this.data.stocks)) s.open = s.price; this.dirty(); }
      this.wasLive = stream.live;
    });
    this.syncTimer();
    this.publish();
  }

  private get cfg(): MarketSettings {
    return this.ctx.settings.get('market');
  }

  private get ru(): boolean {
    return this.ctx.settings.get('language') === 'ru';
  }

  /** For tests and the UI. */
  get snapshot(): MarketData {
    return this.data;
  }

  private load(): MarketData {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<MarketData>;
        if (raw && raw.version === 1 && raw.wallets && raw.stocks) return { ...emptyMarket(), ...raw } as MarketData;
      }
    } catch (err) {
      console.error('[market] data file is corrupted, starting a fresh market', err);
      try { renameSync(this.file, this.file + '.corrupted-' + Date.now()); } catch { /* keep going */ }
    }
    return emptyMarket();
  }

  private dirty(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 2000);
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + '.tmp', JSON.stringify(this.data), 'utf8');
      renameSync(this.file + '.tmp', this.file);
    } catch (err) {
      console.error('[market] save failed', err);
    }
  }

  private syncTimer(): void {
    const every = this.cfg.enabled ? Math.max(15, this.cfg.tickSec) * 1000 : 0;
    if (every === this.tickEvery) return;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = every ? setInterval(() => this.tick(), every) : null;
    this.tickEvery = every;
  }

  private excluded(login: string): boolean {
    return this.cfg.exclude.some((x) => x.trim().toLowerCase() === login.toLowerCase());
  }

  private wallet(m: Pick<ChatMessage, 'userId' | 'userName' | 'userLogin'>): Wallet {
    let w = this.data.wallets[m.userId];
    if (!w) {
      w = { name: m.userName, login: m.userLogin.toLowerCase(), balance: this.cfg.startBalance, holdings: {}, lastEarnAt: 0, lastChatAt: 0 };
      this.data.wallets[m.userId] = w;
      this.trimWallets();
    }
    w.name = m.userName;
    w.login = m.userLogin.toLowerCase();
    return w;
  }

  private trimWallets(): void {
    const ids = Object.keys(this.data.wallets);
    if (ids.length <= MAX_WALLETS) return;
    // Forget the longest-silent viewers who own nothing.
    const idle = ids
      .filter((id) => !Object.values(this.data.wallets[id].holdings).some((h) => h.qty > 0) && !this.data.stocks[id]?.listed)
      .sort((a, b) => this.data.wallets[a].lastChatAt - this.data.wallets[b].lastChatAt);
    for (const id of idle.slice(0, ids.length - MAX_WALLETS)) delete this.data.wallets[id];
  }

  private onChat(m: ChatMessage): void {
    const cfg = this.cfg;
    if (!cfg.enabled || m.fromSelf || m.platform !== 'twitch' || this.excluded(m.userLogin)) return;
    const now = m.timestamp || this.now();
    const w = this.wallet(m);
    const parsed = parseCommand(m.text, this.ctx.settings.get('bot').prefix);
    if (parsed && this.command(parsed.name, parsed.args, m, w, now)) { this.dirty(); this.publish(); return; }
    if (now - w.lastEarnAt >= Math.max(0, cfg.earnCooldownSec) * 1000) {
      w.balance = round2(w.balance + cfg.earnPerMessage);
      w.lastEarnAt = now;
    }
    w.lastChatAt = now;
    this.activitySinceTick = true;
    let s = this.data.stocks[m.userId];
    if (!s) {
      s = { userId: m.userId, name: m.userName, login: m.userLogin.toLowerCase(), price: cfg.ipoPrice, open: cfg.ipoPrice, history: [], messages: 0, tickMessages: 0, avgActivity: 0, lastChatAt: now, dividendTick: -1, listed: false };
      this.data.stocks[m.userId] = s;
    }
    s.name = m.userName;
    s.messages++;
    s.tickMessages++;
    s.lastChatAt = now;
    if (!s.listed && s.messages >= Math.max(1, cfg.listMinMessages)) {
      s.listed = true;
      s.price = s.open = cfg.ipoPrice;
      s.history = [cfg.ipoPrice];
      this.publish();
      if (cfg.announceNews) void this.deps.say(this.ru ? `🔔 IPO! Акции $${s.login} выходят на биржу по ${cfg.ipoPrice} ${cfg.currencyName}.` : `🔔 IPO! $${s.login} shares go public at ${cfg.ipoPrice} ${cfg.currencyName}.`);
    }
    if (s.listed && s.dividendTick !== this.data.tick && cfg.dividendPct > 0) {
      s.dividendTick = this.data.tick;
      for (const holder of Object.values(this.data.wallets)) {
        const h = holder.holdings[m.userId];
        if (h?.qty) holder.balance = round2(holder.balance + (h.qty * s.price * cfg.dividendPct) / 100);
      }
    }
    this.dirty();
  }

  private findStock(raw: string | undefined): Stock | undefined {
    const q = (raw ?? '').replace(/^[@$]/, '').trim().toLowerCase();
    if (!q) return undefined;
    return Object.values(this.data.stocks).find((s) => s.listed && (s.login === q || s.name.toLowerCase() === q));
  }

  /** Handles a market command; false = not ours. */
  private command(name: string, args: string[], m: ChatMessage, w: Wallet, now: number): boolean {
    const c = this.cfg.commands;
    const is = (key: keyof typeof FALLBACK) => name === c[key].trim().toLowerCase().replace(/^[!/]+/, '') || (FALLBACK[key] as readonly string[]).includes(name);
    const kind = (['buy', 'sell', 'portfolio', 'balance', 'price', 'market'] as const).find(is);
    if (!kind) return false;
    if (now - (this.lastReply.get(m.userId) ?? 0) < REPLY_COOLDOWN_MS) return true;
    this.lastReply.set(m.userId, now);
    if (this.lastReply.size > 2000) this.lastReply.delete(this.lastReply.keys().next().value!);
    const reply = (text: string) => void this.deps.say(`@${m.userName}, ${text}`);
    const ru = this.ru;
    const cur = this.cfg.currencyName;
    switch (kind) {
      case 'buy':
      case 'sell': {
        const stock = this.findStock(args[0]);
        if (!stock) { reply(ru ? `такой акции нет. Пример: ${this.ctx.settings.get('bot').prefix}${c[kind]} @ник 5` : `no such stock. Example: ${this.ctx.settings.get('bot').prefix}${c[kind]} @name 5`); return true; }
        const result = kind === 'buy' ? this.buy(m.userId, stock, args[1]) : this.sell(m.userId, stock, args[1]);
        reply(result);
        return true;
      }
      case 'portfolio': {
        const rows = Object.entries(w.holdings).filter(([, h]) => h.qty > 0).map(([id, h]) => {
          const s = this.data.stocks[id];
          const value = (s?.price ?? 0) * h.qty;
          const pl = h.cost > 0 ? ((value - h.cost) / h.cost) * 100 : 0;
          return { text: `$${s?.login ?? '?'} ×${h.qty} (${pl >= 0 ? '+' : ''}${pl.toFixed(0)}%)`, value };
        }).sort((a, b) => b.value - a.value);
        const worth = rows.reduce((sum, r) => sum + r.value, 0);
        reply(rows.length
          ? `${rows.slice(0, 6).map((r) => r.text).join(' · ')} — ${ru ? 'итого' : 'total'} ${Math.round(worth)} ${cur}`
          : (ru ? 'портфель пуст. Купите чью-нибудь акцию!' : 'your portfolio is empty. Buy someone’s stock!'));
        return true;
      }
      case 'balance': {
        const worth = Object.entries(w.holdings).reduce((sum, [id, h]) => sum + (this.data.stocks[id]?.price ?? 0) * h.qty, 0);
        reply(ru ? `${Math.floor(w.balance)} ${cur} на счету, акций на ${Math.round(worth)} ${cur}` : `${Math.floor(w.balance)} ${cur} in cash, ${Math.round(worth)} ${cur} in stocks`);
        return true;
      }
      case 'price': {
        const stock = this.findStock(args[0] ?? m.userLogin);
        if (!stock) { reply(ru ? 'эта акция ещё не на бирже' : 'that stock is not listed yet'); return true; }
        const q = this.quote(stock);
        reply(`$${stock.login}: ${q.price} ${cur} (${q.change >= 0 ? '+' : ''}${q.change}%) · ${ru ? 'держателей' : 'holders'}: ${q.holders}`);
        return true;
      }
      case 'market': {
        const quotes = this.quotes();
        if (!quotes.length) { reply(ru ? 'биржа пока пуста — болтайте больше!' : 'the market is empty — chat more!'); return true; }
        const up = [...quotes].sort((a, b) => b.change - a.change).slice(0, 3).map((q) => `$${this.data.stocks[q.userId]?.login} ${q.change >= 0 ? '+' : ''}${q.change}%`);
        const down = [...quotes].sort((a, b) => a.change - b.change).filter((q) => q.change < 0).slice(0, 2).map((q) => `$${this.data.stocks[q.userId]?.login} ${q.change}%`);
        reply(`📈 ${up.join(' · ')}${down.length ? ` | 📉 ${down.join(' · ')}` : ''}`);
        return true;
      }
    }
  }

  buy(userId: string, stock: Stock, rawQty: string | undefined): string {
    const ru = this.ru;
    const w = this.data.wallets[userId];
    if (!w) return ru ? 'сначала напишите что-нибудь в чат' : 'say something in chat first';
    if (stock.userId === userId) return ru ? 'покупать свои акции нельзя — это инсайдерская торговля 😏' : 'buying your own stock is insider trading 😏';
    const qty = parseQty(rawQty, maxAffordable(stock.price, w.balance, this.cfg.impactPct));
    if (qty === null || qty <= 0) return ru ? 'не хватает монет даже на одну акцию' : 'not enough coins for a single share';
    const price = fillPrice(stock.price, qty, this.cfg.impactPct, 'buy');
    const cost = round2(price * qty);
    if (cost > w.balance) return ru ? `нужно ${Math.ceil(cost)} ${this.cfg.currencyName}, на счету ${Math.floor(w.balance)}` : `that costs ${Math.ceil(cost)} ${this.cfg.currencyName}, you have ${Math.floor(w.balance)}`;
    w.balance = round2(w.balance - cost);
    const h = w.holdings[stock.userId] ?? (w.holdings[stock.userId] = { qty: 0, cost: 0 });
    h.qty += qty;
    h.cost = round2(h.cost + cost);
    stock.price = priceAfterTrade(stock.price, qty, this.cfg.impactPct, 'buy');
    this.trade(w.name, stock, qty, price, 'buy');
    return ru ? `куплено ${qty} шт. $${stock.login} по ${price} = ${Math.round(cost)} ${this.cfg.currencyName}. На счету ${Math.floor(w.balance)}` : `bought ${qty} × $${stock.login} at ${price} = ${Math.round(cost)} ${this.cfg.currencyName}. Cash: ${Math.floor(w.balance)}`;
  }

  sell(userId: string, stock: Stock, rawQty: string | undefined): string {
    const ru = this.ru;
    const w = this.data.wallets[userId];
    const h = w?.holdings[stock.userId];
    if (!w || !h?.qty) return ru ? `у вас нет акций $${stock.login}` : `you own no $${stock.login}`;
    const qty = Math.min(h.qty, parseQty(rawQty, h.qty) ?? 0);
    if (qty <= 0) return ru ? 'сколько продать? Число или «все»' : 'how many? A number or "all"';
    const price = fillPrice(stock.price, qty, this.cfg.impactPct, 'sell');
    const proceeds = round2(price * qty);
    const costPart = round2((h.cost * qty) / h.qty);
    h.qty -= qty;
    h.cost = round2(h.cost - costPart);
    if (!h.qty) delete w.holdings[stock.userId];
    w.balance = round2(w.balance + proceeds);
    stock.price = priceAfterTrade(stock.price, qty, this.cfg.impactPct, 'sell');
    this.trade(w.name, stock, qty, price, 'sell');
    const pl = proceeds - costPart;
    return ru
      ? `продано ${qty} шт. $${stock.login} за ${Math.round(proceeds)} (${pl >= 0 ? 'прибыль' : 'убыток'} ${Math.abs(Math.round(pl))}). На счету ${Math.floor(w.balance)}`
      : `sold ${qty} × $${stock.login} for ${Math.round(proceeds)} (${pl >= 0 ? 'profit' : 'loss'} ${Math.abs(Math.round(pl))}). Cash: ${Math.floor(w.balance)}`;
  }

  private trade(user: string, stock: Stock, qty: number, price: number, side: 'buy' | 'sell'): void {
    this.ctx.state.patch('market', { lastTrade: { user, stock: stock.login, qty, price, side, at: this.now() } });
  }

  /** One market step: prices follow chat activity, active chatters get their income. */
  tick(): void {
    const cfg = this.cfg;
    if (!cfg.enabled) return;
    const live = this.ctx.state.current.stream.live;
    // Offline and silent: the market sleeps instead of draining everyone's prices.
    if (!live && !this.activitySinceTick) return;
    this.activitySinceTick = false;
    const now = this.now();
    this.data.tick++;
    const news: string[] = [];
    for (const s of Object.values(this.data.stocks)) {
      if (!s.listed) { s.tickMessages = 0; continue; }
      const before = s.price;
      const next = nextPrice(s, cfg, live, this.rand);
      s.price = next.price;
      s.avgActivity = next.avg;
      s.tickMessages = 0;
      s.history = [...s.history, s.price].slice(-HISTORY);
      const move = ((s.price - before) / before) * 100;
      if (Math.abs(move) >= NEWS_MOVE && news.length < 1) {
        news.push(move < 0
          ? (this.ru ? `📉 Обвал! $${s.login} −${Math.abs(move).toFixed(0)}% — ${s.price}` : `📉 Crash! $${s.login} −${Math.abs(move).toFixed(0)}% — ${s.price}`)
          : (this.ru ? `🚀 $${s.login} взлетает на +${move.toFixed(0)}% — ${s.price}` : `🚀 $${s.login} soars +${move.toFixed(0)}% — ${s.price}`));
      }
    }
    if (cfg.activeIncome > 0) {
      for (const w of Object.values(this.data.wallets)) if (now - w.lastChatAt <= ACTIVE_MS) w.balance = round2(w.balance + cfg.activeIncome);
    }
    if (cfg.announceNews && news.length) void this.deps.say(news[0]);
    this.dirty();
    this.publish();
  }

  /** Shareholders per stock, counted in one pass over the wallets. */
  private holderCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const w of Object.values(this.data.wallets)) {
      for (const [id, h] of Object.entries(w.holdings)) if (h.qty > 0) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }

  private quote(s: Stock, holders = this.holderCounts()): StockQuote {
    return { userId: s.userId, name: s.name, price: s.price, change: s.open ? round2(((s.price - s.open) / s.open) * 100) : 0, history: s.history, holders: holders.get(s.userId) ?? 0 };
  }

  quotes(): StockQuote[] {
    const holders = this.holderCounts();
    return Object.values(this.data.stocks).filter((s) => s.listed).map((s) => this.quote(s, holders)).sort((a, b) => b.price - a.price);
  }

  private publish(): void {
    const quotes = this.quotes();
    this.lastQuotes = quotes;
    const worth = (w: Wallet) => w.balance + Object.entries(w.holdings).reduce((sum, [id, h]) => sum + (this.data.stocks[id]?.price ?? 0) * h.qty, 0);
    const wallets = Object.values(this.data.wallets);
    const state: Partial<MarketState> = {
      quotes: quotes.slice(0, 30),
      richest: wallets.map((w) => ({ name: w.name, worth: Math.round(worth(w)) })).sort((a, b) => b.worth - a.worth).slice(0, 5),
      traders: wallets.filter((w) => Object.values(w.holdings).some((h) => h.qty > 0)).length,
    };
    this.ctx.state.patch('market', state);
    this.deps.broadcast('stocks', this.overlayMessage(quotes));
  }

  private lastQuotes: StockQuote[] | null = null;

  overlayMessage(quotes = this.lastQuotes ?? this.quotes()): OverlayMessage {
    return { type: 'stocks', quotes: quotes.slice(0, Math.max(1, this.cfg.tickerCount)), lastTrade: this.ctx.state.current.market.lastTrade, style: this.cfg, lang: this.ctx.settings.get('language') };
  }

  grant(login: string, amount: number): void {
    const l = login.replace(/^@/, '').trim().toLowerCase();
    if (!l || !Number.isFinite(amount)) throw new Error(this.ru ? 'Укажите ник и сумму' : 'Enter a name and an amount');
    const entry = Object.entries(this.data.wallets).find(([, w]) => w.login === l);
    if (!entry) throw new Error(this.ru ? 'Этот зритель ещё не писал в чат' : 'This viewer has not chatted yet');
    entry[1].balance = Math.max(0, round2(entry[1].balance + amount));
    this.dirty();
    this.publish();
  }

  reset(): void {
    this.data = emptyMarket();
    this.ctx.state.patch('market', { lastTrade: null });
    this.flush();
    this.publish();
  }

  dispose(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.flush();
  }
}
