import { uid } from '@shared/defaults';
import type { KawakiSettings } from '@shared/types';
import { Icon } from '../components/icons';
import { OverlayBar, OverlayPreview } from '../components/overlay';
import { Button, Card, CopyField, Field, PageHeader, StatusText, TextArea, TextInput, Toggle } from '../components/ui';
import { useNow } from '../hooks';
import { useT } from '../i18n';
import { call, navigate, saveSettings, toast, useApp } from '../store';
import { KawakiStyleCard } from './Overlays';

export function Kawaki() {
  const t = useT();
  const st = useApp((d) => d.state!.kawaki);
  const connected = !!st.account;
  return (
    <div className="page page-wide">
      <PageHeader title="Kawaki" subtitle={t('kawaki.subtitle')} actions={<StatusText status={st.status} error={st.error} />} />
      <div className="kawaki-layout">
        <div className="stack-lg">
          <AccountCard />
          {connected && <NowWatchingCard />}
          {connected && st.partner && <PartnerCard />}
          <ChatTitleCard />
        </div>
        <div className="stack-lg">
          <Card title={t('kawaki.overlay')} icon="layers">
            <OverlayPreview kind="kawaki" maxHeight={220} />
            <OverlayBar kind="kawaki" name="Kawaki" />
          </Card>
          <KawakiStyleCard />
          <Card className="callout">
            <Icon name="quiz" size={20} />
            <div>
              <b>{t('kawaki.quizTitle')}</b>
              <p className="muted small">{t('kawaki.quizText')}</p>
            </div>
            <Button onClick={() => navigate('interactive', 'quiz')}>{t('kawaki.quizOpen')}</Button>
          </Card>
        </div>
      </div>
    </div>
  );
}

function AccountCard() {
  const t = useT();
  const st = useApp((d) => d.state!.kawaki);
  const now = useNow(1000);
  return (
    <Card title={t('kawaki.account')} icon="tv" className="conn-card">
      {!st.account && !st.deviceCode && <p className="muted">{t('kawaki.why')}</p>}
      {st.account && (
        <div className="account">
          {st.account.avatarUrl && <img src={st.account.avatarUrl} alt="" />}
          <div>
            <b>{st.account.displayName}</b>
            <span className="muted small">kawaki.ru/u/{st.account.login}</span>
          </div>
        </div>
      )}
      {st.deviceCode ? (
        <div className="device-code">
          <p>{t('kawaki.deviceStep')}</p>
          <div className="code">{st.deviceCode.userCode}</div>
          <div className="row-gap">
            <Button variant="primary" icon="external" onClick={() => void call('shell:openExternal', st.deviceCode!.verificationUri)}>
              {t('kawaki.openSite')}
            </Button>
            <Button onClick={() => void call('kawaki:cancelLogin')}>{t('common.cancel')}</Button>
          </div>
          <p className="muted small">{t('conn.deviceExpires', { sec: Math.max(0, Math.round((st.deviceCode.expiresAt - now) / 1000)) })}</p>
        </div>
      ) : st.account ? (
        <Button icon="logout" onClick={() => void call('kawaki:logout')}>
          {t('conn.logout')}
        </Button>
      ) : (
        <Button variant="primary" icon="plug" onClick={() => void call('kawaki:login')}>
          {t('kawaki.login')}
        </Button>
      )}
      {st.error && st.status === 'error' && <p className="error small">{st.error}</p>}
    </Card>
  );
}

function NowWatchingCard() {
  const t = useT();
  const w = useApp((d) => d.state!.kawaki.nowWatching);
  return (
    <Card
      title={t('kawaki.now')}
      icon="play"
      actions={<Button size="sm" icon="refresh" onClick={() => void call('kawaki:refresh')}>{t('common.reload')}</Button>}
    >
      {!w ? (
        <p className="muted">{t('kawaki.nothing')}</p>
      ) : (
        <div className="now-watching">
          {w.posterUrl && <img src={w.posterUrl} alt="" />}
          <div>
            <b className="now-title">{w.title}</b>
            {w.titleEn && <span className="muted small">{w.titleEn}</span>}
            <span>
              {w.episode != null ? t('kawaki.episode', { n: w.episode }) : ''}
              {w.episode != null && w.episodesTotal ? t('kawaki.of', { n: w.episodesTotal }) : ''}
            </span>
            <span className={`source-badge ${w.source}`}>{w.source === 'live' ? t('kawaki.sourceLive') : t('kawaki.sourceList')}</span>
            <Button size="sm" icon="external" onClick={() => void call('shell:openExternal', w.url)}>
              {t('kawaki.openAnime')}
            </Button>
          </div>
        </div>
      )}
      {w?.source === 'list' && <p className="muted small">{t('kawaki.listHint')}</p>}
    </Card>
  );
}

function PartnerCard() {
  const t = useT();
  const partner = useApp((d) => d.state!.kawaki.partner)!;
  const bot = useApp((d) => d.settings!.bot);
  const lang = useApp((d) => d.settings!.language);
  const hasCommand = bot.commands.some((c) => c.response.includes('{kawaki}'));
  return (
    <Card title={t('kawaki.partner')} icon="star">
      <p className="muted">{t('kawaki.partnerText', { name: partner.displayName })}</p>
      <CopyField value={partner.liveUrl} />
      {!hasCommand && (
        <div className="row-gap wrap" style={{ marginTop: 12 }}>
          <Button
            icon="plus"
            onClick={() => {
              saveSettings('bot', {
                ...bot,
                commands: [
                  {
                    id: uid('cmd_'),
                    enabled: true,
                    trigger: 'kawaki',
                    aliases: lang === 'ru' ? ['каваки'] : [],
                    response: lang === 'ru' ? 'Смотри эфир на Kawaki и получай карточки за просмотр: {kawaki}' : 'Watch the stream on Kawaki and earn cards: {kawaki}',
                    permission: 'everyone',
                    cooldownSec: 30,
                    userCooldownSec: 0,
                    reply: false,
                  },
                  ...bot.commands,
                ],
              });
              toast('success', 'toast.kawakiCommandAdded');
            }}
          >
            {t('kawaki.addCommand')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function ChatTitleCard() {
  const t = useT();
  const k = useApp((d) => d.settings!.kawaki);
  const prefix = useApp((d) => d.settings!.bot.prefix);
  const trigger = useApp((d) => d.settings!.bot.builtins.find((b) => b.id === 'anime'));
  const set = (patch: Partial<KawakiSettings>) => saveSettings('kawaki', { ...k, ...patch });
  return (
    <Card title={t('kawaki.chatTitle')} icon="chat">
      <div className="form">
        <Field label={t('kawaki.command', { cmd: `${prefix}${trigger?.trigger ?? 'anime'}` })} hint={trigger?.enabled === false ? t('kawaki.commandOff') : t('kawaki.commandHint')} wide>
          <TextArea value={k.commandTemplate} onChange={(commandTemplate) => set({ commandTemplate })} rows={2} />
        </Field>
        <Field label={t('kawaki.autoTitle')} hint={t('kawaki.autoTitleHint')} wide>
          <Toggle checked={k.autoTitle} onChange={(autoTitle) => set({ autoTitle })} label={k.autoTitle ? t('common.on') : t('common.off')} />
        </Field>
        <Field label={t('kawaki.titleTemplate')} wide>
          <TextInput value={k.titleTemplate} onChange={(titleTemplate) => set({ titleTemplate })} />
        </Field>
        <Field label=" " wide>
          <p className="muted small vars-help">{t('kawaki.vars')}</p>
        </Field>
        <Field label={t('kawaki.baseUrl')} hint={t('kawaki.baseUrlHint')} wide>
          <TextInput value={k.baseUrl} onChange={(baseUrl) => set({ baseUrl: baseUrl.trim() })} mono />
        </Field>
      </div>
    </Card>
  );
}
