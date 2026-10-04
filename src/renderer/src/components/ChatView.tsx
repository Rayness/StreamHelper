import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@shared/types';
import { useClock } from '../hooks';
import { useT } from '../i18n';
import { call, callOk, useApp } from '../store';
import { Icon } from './icons';
import { Empty, IconButton } from './ui';

const FALLBACK_COLORS = ['#ff7a7a', '#ffb86b', '#e8d44d', '#6ee06e', '#5fd7d7', '#6bb8ff', '#b88bff', '#ff7ad9'];
const colorFor = (login: string) => FALLBACK_COLORS[[...login].reduce((a, c) => a + c.charCodeAt(0), 0) % FALLBACK_COLORS.length];

/** Twitch lets users pick near-black colors; lift them so names stay readable on a dark UI. */
function readable(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum > 90) return color;
  const k = 90 / Math.max(lum, 1);
  const lift = (c: number) => Math.min(255, Math.round(c * k + 60));
  return `rgb(${lift(r)}, ${lift(g)}, ${lift(b)})`;
}

const Message = memo(function Message({ m, canModerate, onReply }: { m: ChatMessage; canModerate: boolean; onReply: (m: ChatMessage) => void }) {
  const t = useT();
  const clock = useClock();
  const color = readable(m.color || colorFor(m.userLogin));
  return (
    <div className={`chat-msg ${m.deleted ? 'deleted' : ''} ${m.highlighted ? 'highlighted' : ''} ${m.fromSelf ? 'self' : ''}`}>
      {m.replyTo && (
        <div className="chat-reply">
          <Icon name="replay" size={12} /> @{m.replyTo.userName}: {m.replyTo.text}
        </div>
      )}
      <span className="chat-time">{clock(m.timestamp)}</span>
      {m.badges.map((b) => (b.imageUrl ? <img key={b.id} className="chat-badge" src={b.imageUrl} alt={b.title ?? b.id} title={b.title ?? b.id} /> : null))}
      <span className="chat-name" style={{ color }}>
        {m.userName}
      </span>
      <span className="chat-sep">{m.isAction ? ' ' : ': '}</span>
      <span className="chat-text" style={m.isAction ? { color, fontStyle: 'italic' } : undefined}>
        {m.fragments.map((f, i) => {
          switch (f.type) {
            case 'emote':
              return <img key={i} className="chat-emote" src={f.url} alt={f.text} title={f.text} />;
            case 'mention':
              return (
                <span key={i} className="chat-mention">
                  {f.text}
                </span>
              );
            case 'link':
              return (
                <a key={i} href={f.url} target="_blank" rel="noreferrer">
                  {f.text}
                </a>
              );
            default:
              return <span key={i}>{f.text}</span>;
          }
        })}
      </span>
      {m.bits ? <span className="chat-bits">◆ {m.bits}</span> : null}
      {!m.deleted && (
        <span className="chat-actions">
          <IconButton icon="replay" label={t('chat.reply')} onClick={() => onReply(m)} />
          <IconButton icon="eye" label={t('spotlight.show')} onClick={() => void call('spotlight:show', m.id)} />
          {canModerate && !m.roles.broadcaster && (
            <>
              <IconButton icon="trash" label={t('chat.delete')} onClick={() => void call('chat:delete', m.id)} />
              <IconButton icon="clock" label={t('chat.timeout')} onClick={() => void call('chat:timeout', m.userId, 600)} />
              <IconButton icon="ban" label={t('chat.ban')} variant="danger" onClick={() => confirm(t('chat.banConfirm', { user: m.userName })) && void call('chat:ban', m.userId)} />
            </>
          )}
        </span>
      )}
    </div>
  );
});

export function ChatView({ readOnly = false }: { readOnly?: boolean }) {
  const t = useT();
  const chat = useApp((d) => d.chat);
  const connected = useApp((d) => d.state?.twitch.status === 'connected');
  const botName = useApp((d) => d.state?.twitchBot.account?.displayName);
  const spotlight = useApp((d) => d.state?.spotlight);
  const listRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [sending, setSending] = useState(false);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [chat, stick]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const send = async () => {
    const msg = text.trim();
    if (!msg || sending) return;
    setSending(true);
    // Keep the text on failure so the streamer can retry.
    const ok = await callOk('chat:send', msg, replyTo?.id);
    setSending(false);
    if (ok) {
      setText('');
      setReplyTo(null);
    }
  };

  return (
    <div className="chat">
      <div className="chat-list" ref={listRef}>
        {chat.length === 0 ? (
          <Empty icon="chat" title={connected ? t('chat.emptyConnected') : t('chat.emptyDisconnected')}>
            {connected ? t('chat.emptyConnectedHint') : t('chat.emptyDisconnectedHint')}
          </Empty>
        ) : (
          chat.map((m) => <Message key={m.id} m={m} canModerate={connected && !readOnly} onReply={setReplyTo} />)
        )}
      </div>
      {!stick && chat.length > 0 && (
        <button type="button" className="chat-jump" onClick={() => setStick(true)}>
          {t('chat.jump')}
        </button>
      )}
      {!readOnly && spotlight && <div className="chat-replying"><span>{t('spotlight.active')}: <b>{spotlight.userName}</b> — {spotlight.text}</span><IconButton icon="x" label={t('spotlight.clear')} onClick={() => void call('spotlight:clear')} /></div>}
      {replyTo && (
        <div className="chat-replying">
          <span>
            {t('chat.replyingTo')} <b>{replyTo.userName}</b>: {replyTo.text}
          </span>
          <IconButton icon="x" label={t('common.cancel')} onClick={() => setReplyTo(null)} />
        </div>
      )}
      {!readOnly && <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {botName && <span className="chat-sender" title={t('workspace.botSender', { name: botName })}>{botName}</span>}
        <input
          className="input"
          value={text}
          maxLength={500}
          disabled={!connected}
          placeholder={connected ? t('chat.placeholder') : t('chat.placeholderDisconnected')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setReplyTo(null)}
        />
        <IconButton icon="send" label={t('chat.send')} variant="primary" disabled={!connected || !text.trim() || sending} type="submit" />
      </form>}
    </div>
  );
}
