import { useState } from 'react';
import { DEFAULT_TWITCH_CLIENT_ID, twitchClientId } from '@shared/defaults';
import { CONNECTION_TABS, type ConnectionTab } from '@shared/workspace';
import type { ConnectionState, DeviceCodePrompt } from '@shared/types';
import { Button, Card, CopyField, Field, NumberInput, Select, StatusText, TextInput, Toggle } from '../components/ui';
import { Icon } from '../components/icons';
import { moduleDef } from '../workspaceModules';
import { SubForStream } from './Obs';
import { KawakiAccountCard } from './Kawaki';
import { useNow } from '../hooks';
import { useT } from '../i18n';
import { call, callOk, openModule, saveSettings, useApp, useSub } from '../store';

export function Connections() {
  const t = useT();
  const [selected, setSelected] = useSub<ConnectionTab>('connections', 'twitch', CONNECTION_TABS);
  const state = useApp((d) => d.state!);
  return <div className="workspace connections-page">
    <header className="workspace-header"><div><h1>{t('nav.connections')}</h1><p className="muted small">{t('connections.hint')}</p></div></header>
    <div className="connections-layout"><aside className="connections-list" aria-label={t('nav.connections')}>
      {CONNECTION_TABS.map((id) => <button key={id} data-connection={id} className={selected === id ? 'active' : ''} onClick={() => setSelected(id)}><Icon name={moduleDef(id).icon} size={18} /><span>{id === 'kawaki' ? 'Kawaki' : moduleDef(id).name}</span><span className={`status-dot status-${state[id === 'subforstream' ? 'subForStream' : id].status}`} /></button>)}
    </aside><section className="connection-editor" data-connection-editor={selected} key={selected}>
      {selected === 'subforstream' ? <SubForStream /> : selected === 'kawaki' ? <KawakiConnection /> : <ConnectionDetail kind={selected} />}
    </section></div>
  </div>;
}

/** Kawaki login lives with the other accounts; the Kawaki module keeps the overlay and "now watching". */
function KawakiConnection() {
  const t = useT();
  const cards = useApp((d) => d.settings!.workspace.cards);
  return <>
    <KawakiAccountCard />
    <p className="muted small">{t('kawaki.connectionHint')}</p>
    <div className="row-gap"><Button icon="tv" onClick={() => openModule('kawaki')}>{cards.includes('kawaki') ? t('kawaki.openModule') : t('kawaki.addModule')}</Button></div>
  </>;
}

function Account({ state }: { state: ConnectionState }) {
  if (!state.account) return null;
  return (
    <div className="account">
      {state.account.avatarUrl && <img src={state.account.avatarUrl} alt="" />}
      <div>
        <b>{state.account.displayName}</b>
        <span className="muted small">@{state.account.login}</span>
      </div>
    </div>
  );
}

function DeviceCode({ prompt, onCancel }: { prompt: DeviceCodePrompt; onCancel: () => void }) {
  const t = useT();
  const now = useNow(1000);
  const left = Math.max(0, Math.round((prompt.expiresAt - now) / 1000));
  return (
    <div className="device-code">
      <p>{t('conn.deviceStep')}</p>
      <div className="code">{prompt.userCode}</div>
      <div className="row-gap">
        <Button variant="primary" icon="external" onClick={() => void call('shell:openExternal', prompt.verificationUri)}>
          {t('conn.openTwitch')}
        </Button>
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
      <p className="muted small">{t('conn.deviceExpires', { sec: left })}</p>
    </div>
  );
}

export function TwitchCard({ account }: { account: 'broadcaster' | 'bot' }) {
  const t = useT();
  const state = useApp((d) => (account === 'broadcaster' ? d.state!.twitch : d.state!.twitchBot));
  const subscriptionErrors = useApp((d) => account === 'broadcaster' ? d.state!.twitch.subscriptionErrors : undefined);
  const clientId = useApp((d) => d.settings!.twitch.clientId);
  const hasClientId = !!twitchClientId(clientId);
  const loggedIn = !!state.account;
  return (
    <Card
      className="conn-card"
      title={
        <span className="conn-title">
          <span className="brand twitch" />
          {account === 'broadcaster' ? t('conn.twitch') : t('conn.twitchBot')}
        </span>
      }
      actions={<StatusText status={state.status} error={state.error} />}
    >
      <p className="muted small">{account === 'broadcaster' ? t('conn.twitchHint') : t('conn.twitchBotHint')}</p>
      <Account state={state} />
      {account === 'bot' && <p className="muted small">{t('bot.accountHelp')}</p>}
      {subscriptionErrors && Object.keys(subscriptionErrors).length > 0 && (
        <div className="connection-warning">
          <p>{t('conn.partialTwitch')}</p>
          <ul>{Object.keys(subscriptionErrors).map((type) => <li key={type}>{type}</li>)}</ul>
          <Button size="sm" onClick={() => void call('twitch:login', account)}>{t('conn.renewPermissions')}</Button>
        </div>
      )}
      {state.deviceCode ? (
        <DeviceCode prompt={state.deviceCode} onCancel={() => void call('twitch:cancelLogin', account)} />
      ) : loggedIn ? (
        <Button icon="logout" onClick={() => void call('twitch:logout', account)}>
          {t('conn.logout')}
        </Button>
      ) : (
        <>
          {!hasClientId && account === 'broadcaster' && (
            <Field label="Twitch Client ID" hint={t('conn.needClientId')}>
              <TextInput value={clientId} onChange={(v) => saveSettings('twitch', { clientId: v.trim() })} mono />
            </Field>
          )}
          <Button variant="primary" icon="plug" disabled={!hasClientId} onClick={() => void call('twitch:login', account)}>
            {t('conn.login')}
          </Button>
        </>
      )}
      {state.error && state.status !== 'connected' && <p className="error small">{state.error}</p>}
    </Card>
  );
}

function DonationAlertsCard() {
  const t = useT();
  const state = useApp((d) => d.state!.donationalerts);
  const da = useApp((d) => d.settings!.donationalerts);
  const url = useApp((d) => d.state!.overlayUrl);
  const loggedIn = !!state.account;
  return (
    <Card
      className="conn-card"
      title={
        <span className="conn-title">
          <span className="brand da" />
          DonationAlerts
        </span>
      }
      actions={<StatusText status={state.status} error={state.error} />}
    >
      <p className="muted small">{t('conn.daHint')}</p>
      <Account state={state} />
      {!loggedIn && (
        <>
          <Field label="Client ID" hint={t('conn.daClientHint')}>
            <TextInput value={da.clientId} onChange={(clientId) => saveSettings('donationalerts', { ...da, clientId: clientId.trim() })} mono />
          </Field>
          {url && <CopyField label="Redirect URI" value={`${url}/auth/donationalerts`} />}
        </>
      )}
      {loggedIn ? (
        <Button icon="logout" onClick={() => void call('da:logout')}>
          {t('conn.logout')}
        </Button>
      ) : (
        <Button variant="primary" icon="plug" disabled={!da.clientId || !url} onClick={() => void call('da:login')}>
          {t('conn.login')}
        </Button>
      )}
    </Card>
  );
}

function StreamlabsCard() {
  const t = useT();
  const state = useApp((d) => d.state!.streamlabs);
  const enabled = useApp((d) => d.settings!.streamlabs.enabled);
  const [token, setToken] = useState('');
  return (
    <Card
      className="conn-card"
      title={
        <span className="conn-title">
          <span className="brand sl" />
          Streamlabs
        </span>
      }
      actions={<StatusText status={state.status} error={state.error} />}
    >
      <p className="muted small">{t('conn.slHint')}</p>
      {enabled ? (
        <Button icon="logout" onClick={() => void call('streamlabs:disconnect')}>
          {t('common.disconnect')}
        </Button>
      ) : (
        <>
          <Field label="Socket API Token">
            <TextInput type="password" value={token} onChange={setToken} mono />
          </Field>
          <Button
            variant="primary"
            icon="plug"
            disabled={token.trim().length < 20}
            onClick={() => {
              void call('streamlabs:connect', token);
              setToken('');
            }}
          >
            {t('common.connect')}
          </Button>
        </>
      )}
    </Card>
  );
}

function StreamElementsCard() {
  const t = useT();
  const state = useApp((d) => d.state!.streamelements);
  const enabled = useApp((d) => d.settings!.streamelements.enabled);
  const [channelId, setChannelId] = useState('');
  const [token, setToken] = useState('');
  return (
    <Card className="conn-card" title={<span className="conn-title">StreamElements</span>} actions={<StatusText status={state.status} error={state.error} />}>
      <p className="muted small">{t('integration.seHint')}</p>
      {enabled ? (
        <Button icon="logout" onClick={() => void call('streamelements:disconnect')}>{t('common.disconnect')}</Button>
      ) : (
        <div className="form compact">
          <Field label={t('integration.channelId')}><TextInput value={channelId} onChange={setChannelId} mono /></Field>
          <Field label="JWT"><TextInput type="password" value={token} onChange={setToken} mono /></Field>
          <Button variant="primary" icon="plug" disabled={!/^[a-f\d]{24}$/i.test(channelId.trim()) || token.trim().length < 20} onClick={async () => {
            if (await callOk('streamelements:connect', channelId, token)) setToken('');
          }}>{t('common.connect')}</Button>
        </div>
      )}
    </Card>
  );
}

function StreamerBotCard() {
  const t = useT();
  const state = useApp((d) => d.state!.streamerbot);
  const saved = useApp((d) => d.settings!.streamerbot);
  const [port, setPort] = useState(saved.port);
  return (
    <Card className="conn-card" title={<span className="conn-title">Streamer.bot</span>} actions={<StatusText status={state.status} error={state.error} />}>
      <p className="muted small">{t('integration.sbHint')}</p>
      <div className="form compact">
        <Field label={t('conn.port')}><NumberInput value={port} min={1} max={65535} onChange={setPort} /></Field>
        <div className="row-gap">
          <Button variant="primary" icon="plug" onClick={() => void call('streamerbot:connect', port)}>{saved.enabled ? t('conn.reconnect') : t('common.connect')}</Button>
          {saved.enabled && <Button icon="logout" onClick={() => void call('streamerbot:disconnect')}>{t('common.disconnect')}</Button>}
          {saved.enabled && <Button onClick={() => void call('streamerbot:refresh')}>{t('integration.refresh')}</Button>}
        </div>
        {state.status === 'connected' && <p className="muted small">{t('integration.sbActions', { count: state.actions.length })}</p>}
      </div>
    </Card>
  );
}

function DiscordCard() {
  const t = useT();
  const state = useApp((d) => d.state!.discord);
  const config = useApp((d) => d.settings!.discord);
  const [url, setUrl] = useState('');
  const setOption = (key: 'notifyLive' | 'notifyOffline' | 'notifyDonations', value: boolean) => saveSettings('discord', { ...config, [key]: value });
  return (
    <Card className="conn-card" title={<span className="conn-title">Discord</span>} actions={<StatusText status={state.status} error={state.error} />}>
      <p className="muted small">{t('integration.discordHint')}</p>
      {config.enabled ? (
        <div className="form compact">
          <Field label={t('integration.notifyLive')}><Toggle checked={config.notifyLive} onChange={(v) => setOption('notifyLive', v)} /></Field>
          <Field label={t('integration.notifyOffline')}><Toggle checked={config.notifyOffline} onChange={(v) => setOption('notifyOffline', v)} /></Field>
          <Field label={t('integration.notifyDonations')}><Toggle checked={config.notifyDonations} onChange={(v) => setOption('notifyDonations', v)} /></Field>
          <div className="row-gap">
            <Button onClick={() => void call('discord:test')}>{t('integration.test')}</Button>
            <Button icon="logout" onClick={() => void call('discord:disconnect')}>{t('common.disconnect')}</Button>
          </div>
        </div>
      ) : (
        <div className="form compact">
          <Field label="Webhook URL"><TextInput type="password" value={url} onChange={setUrl} mono /></Field>
          <Button variant="primary" icon="plug" disabled={!url.trim()} onClick={async () => {
            if (await callOk('discord:connect', url)) setUrl('');
          }}>{t('common.connect')}</Button>
        </div>
      )}
    </Card>
  );
}

function ObsCard() {
  const t = useT();
  const state = useApp((d) => d.state!.obs);
  const obs = useApp((d) => d.settings!.obs);
  const [password, setPassword] = useState('');
  const connected = state.status === 'connected';
  return (
    <Card
      className="conn-card"
      title={
        <span className="conn-title">
          <span className="brand obs" />
          OBS Studio
        </span>
      }
      actions={<StatusText status={state.status} error={state.error} />}
    >
      <p className="muted small">{t('conn.obsHint')}</p>
      <div className="form compact">
        <Field label={t('conn.host')}>
          <TextInput value={obs.host} onChange={(host) => saveSettings('obs', { ...obs, host })} mono />
        </Field>
        <Field label={t('conn.port')}>
          <NumberInput value={obs.port} min={1} max={65535} onChange={(port) => saveSettings('obs', { ...obs, port })} />
        </Field>
        <Field label={t('conn.password')} hint={t('conn.passwordHint')}>
          <TextInput type="password" value={password} onChange={setPassword} />
        </Field>
        <Field label={t('conn.autoConnect')}>
          <Toggle checked={obs.autoConnect} onChange={(autoConnect) => saveSettings('obs', { ...obs, autoConnect })} />
        </Field>
        <Field label={t('obs.groupMode')} hint={t(`obs.groupMode_${obs.group ?? 'perScene'}_hint`)} wide>
          <Select value={obs.group ?? 'perScene'} onChange={(group) => saveSettings('obs', { ...obs, group })} options={(['perScene', 'shared', 'none'] as const).map((m) => ({ value: m, label: t(`obs.groupMode_${m}`) }))} />
        </Field>
      </div>
      <div className="row-gap">
        <Button
          variant="primary"
          icon="plug"
          onClick={() => {
            void call('obs:connect', password || undefined);
            setPassword('');
          }}
        >
          {connected ? t('conn.reconnect') : t('common.connect')}
        </Button>
        {connected && (
          <Button icon="logout" onClick={() => void call('obs:disconnect')}>
            {t('common.disconnect')}
          </Button>
        )}
      </div>
      {state.error && state.status !== 'connected' && <p className="error small">{state.error}</p>}
    </Card>
  );
}

export function ConnectionDetail({ kind }: { kind: 'twitch' | 'obs' | 'donationalerts' | 'streamlabs' | 'streamelements' | 'streamerbot' | 'discord' }) {
  const t = useT();
  const cfg = useApp((d) => d.settings!.twitch);
  switch (kind) {
    case 'twitch': return <><TwitchCard account="broadcaster" /><details className="settings-disclosure"><summary>{t('conn.twitchBot')}</summary><TwitchCard account="bot" /></details><details className="settings-disclosure"><summary>{t('settings.advanced')}</summary><Field label="Twitch Client ID" hint={t('settings.clientIdHint')}><TextInput value={cfg.clientId} placeholder={DEFAULT_TWITCH_CLIENT_ID} mono onChange={(clientId) => saveSettings('twitch', { ...cfg, clientId: clientId.trim() })} /></Field></details></>;
    case 'obs': return <ObsCard />;
    case 'donationalerts': return <DonationAlertsCard />;
    case 'streamlabs': return <StreamlabsCard />;
    case 'streamelements': return <StreamElementsCard />;
    case 'streamerbot': return <StreamerBotCard />;
    case 'discord': return <DiscordCard />;
  }
}
