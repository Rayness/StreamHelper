import { useState } from 'react';
import type { ConnectionState, DeviceCodePrompt } from '@shared/types';
import { Button, Card, CopyField, Field, NumberInput, PageHeader, StatusText, TextInput, Toggle } from '../components/ui';
import { useNow } from '../hooks';
import { useT } from '../i18n';
import { call, saveSettings, useApp } from '../store';

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

function TwitchCard({ account }: { account: 'broadcaster' | 'bot' }) {
  const t = useT();
  const state = useApp((d) => (account === 'broadcaster' ? d.state!.twitch : d.state!.twitchBot));
  const clientId = useApp((d) => d.settings!.twitch.clientId);
  const hasClientId = !!clientId.trim();
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

export function Connections() {
  const t = useT();
  return (
    <div className="page">
      <PageHeader title={t('nav.connections')} subtitle={t('conn.subtitle')} />
      <div className="two-col">
        <TwitchCard account="broadcaster" />
        <TwitchCard account="bot" />
        <DonationAlertsCard />
        <StreamlabsCard />
        <ObsCard />
      </div>
    </div>
  );
}
