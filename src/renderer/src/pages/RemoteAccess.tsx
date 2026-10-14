import { useEffect, useState } from 'react';
import { DEFAULT_REMOTE_PORT, REMOTE_PERMISSIONS, type RemoteModerator, type RemotePermission } from '@shared/remote';
import { Button, Card, Empty, Field, NumberInput, Select, TextInput, Toggle } from '../components/ui';
import { useT } from '../i18n';
import { call, callOk, toast, useApp } from '../store';

/** What a new moderator may do until the streamer changes it. */
const DEFAULT_PERMISSIONS: RemotePermission[] = ['chat', 'alerts', 'songs', 'interactive'];
const CUSTOM_HOST = '__custom';

function readHost(): string {
  try {
    return localStorage.getItem('remoteHost') ?? '';
  } catch {
    return '';
  }
}

export function RemoteAccess() {
  const t = useT();
  const remote = useApp((d) => d.state!.remote);
  const enabled = remote.status !== 'off';
  const [port, setPort] = useState(remote.port || DEFAULT_REMOTE_PORT);
  useEffect(() => setPort(remote.port || DEFAULT_REMOTE_PORT), [remote.port]);
  const [name, setName] = useState('');
  const [host, setHostState] = useState(readHost);
  const setHost = (value: string) => {
    setHostState(value);
    try { localStorage.setItem('remoteHost', value); } catch { /* private mode */ }
  };
  const custom = !!host && !remote.addresses.includes(host);
  const [customMode, setCustomMode] = useState(custom);
  const hostChoice = customMode || custom ? CUSTOM_HOST : host || remote.addresses[0] || CUSTOM_HOST;

  const add = async () => {
    const created = await call('remote:addModerator', name.trim() || t('remote.defaultName'), DEFAULT_PERMISSIONS);
    if (created) setName('');
  };
  const copyLink = async (m: RemoteModerator) => {
    const link = await call('remote:link', m.id, hostChoice === CUSTOM_HOST ? host : hostChoice);
    if (link && (await callOk('clipboard:write', link))) toast('success', 'remote.linkCopied', { name: m.name });
  };

  return (
    <>
      <Card title={t('remote.title')} icon="link" actions={<Toggle checked={enabled} onChange={(on) => void call('remote:configure', on, port)} label={enabled ? t('common.on') : t('common.off')} />}>
        <p className="muted small">{t('remote.hint')}</p>
        <div className="form">
          <Field label={t('settings.port')} hint={t('remote.portHint')}>
            <NumberInput value={port} min={1024} max={65535} onChange={setPort} />
          </Field>
          <Field label={' '}>
            <Button disabled={port === remote.port} onClick={() => void call('remote:configure', enabled, port)}>{t('settings.applyPort')}</Button>
          </Field>
        </div>
        {remote.status === 'running' && (
          <p className="small">
            <span className="pill">{t('remote.running')}</span>{' '}
            {remote.addresses.length ? remote.addresses.map((a) => <code key={a} className="remote-address">http://{a}:{remote.port}</code>) : <span className="muted">{t('remote.noNetwork')}</span>}
          </p>
        )}
        {remote.status === 'error' && <p className="error small">{remote.error}</p>}
        <details className="remote-help">
          <summary>{t('remote.internetTitle')}</summary>
          <p className="muted small">{t('remote.internetHint')}</p>
        </details>
      </Card>

      <Card title={t('remote.moderators')} icon="users">
        <div className="form">
          <Field label={t('remote.newName')}>
            <TextInput value={name} onChange={setName} placeholder={t('remote.defaultName')} />
          </Field>
          <Field label={' '}>
            <Button variant="primary" icon="plus" onClick={() => void add()}>{t('remote.add')}</Button>
          </Field>
          {remote.moderators.length > 0 && (
            <Field label={t('remote.linkHost')} hint={t('remote.linkHostHint')} wide>
              <div className="row-gap wrap">
                <Select
                  value={hostChoice}
                  onChange={(v) => { setCustomMode(v === CUSTOM_HOST); setHost(v === CUSTOM_HOST ? '' : v); }}
                  options={[...remote.addresses.map((a) => ({ value: a, label: a })), { value: CUSTOM_HOST, label: t('remote.customHost') }]}
                />
                {hostChoice === CUSTOM_HOST && <TextInput value={host} onChange={setHost} placeholder="https://example.trycloudflare.com" />}
              </div>
            </Field>
          )}
        </div>
        {remote.moderators.length === 0 ? (
          <Empty icon="users" title={t('remote.empty')}>{t('remote.emptyHint')}</Empty>
        ) : (
          <ul className="remote-list">
            {remote.moderators.map((m) => (
              <ModeratorRow key={m.id} moderator={m} online={remote.clients.filter((c) => c.moderatorId === m.id).length} onCopy={() => void copyLink(m)} />
            ))}
          </ul>
        )}
      </Card>

      {remote.clients.length > 0 && (
        <Card title={t('remote.online')} icon="eye">
          <ul className="remote-list">
            {remote.clients.map((c) => (
              <li key={c.id} className="remote-row">
                <div className="remote-row-head">
                  <b>{c.name}</b>
                  <span className="muted small">{c.address} · {new Date(c.since).toLocaleTimeString()}</span>
                  <Button size="sm" icon="logout" onClick={() => void call('remote:kick', c.id)}>{t('remote.kick')}</Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {remote.log.length > 0 && (
        <Card title={t('remote.log')} icon="clock">
          <ul className="remote-log">
            {remote.log.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <span className="muted">{new Date(e.at).toLocaleTimeString()}</span> <b>{e.name}</b> <code>{e.action}{e.detail ? ` · ${e.detail}` : ''}</code>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function ModeratorRow({ moderator, online, onCopy }: { moderator: RemoteModerator; online: number; onCopy: () => void }) {
  const t = useT();
  const [name, setName] = useState(moderator.name);
  useEffect(() => setName(moderator.name), [moderator.name]);
  const toggle = (p: RemotePermission) => {
    const permissions = moderator.permissions.includes(p) ? moderator.permissions.filter((x) => x !== p) : [...moderator.permissions, p];
    void call('remote:updateModerator', moderator.id, { permissions });
  };
  return (
    <li className="remote-row">
      <div className="remote-row-head">
        <TextInput value={name} onChange={setName} />
        {name.trim() && name.trim() !== moderator.name && <Button size="sm" icon="check" onClick={() => void call('remote:updateModerator', moderator.id, { name })}>{t('remote.rename')}</Button>}
        {online > 0 && <span className="pill remote-online">{t('remote.onlineCount', { count: online })}</span>}
        <Button size="sm" icon="copy" onClick={onCopy}>{t('remote.copyLink')}</Button>
        <Button size="sm" icon="refresh" onClick={() => { if (confirm(t('remote.resetConfirm'))) void call('remote:resetKey', moderator.id); }}>{t('remote.resetKey')}</Button>
        <Button size="sm" icon="trash" onClick={() => { if (confirm(t('common.confirmDelete'))) void call('remote:removeModerator', moderator.id); }}>{t('common.delete')}</Button>
      </div>
      <div className="chips" role="group" aria-label={t('remote.permissions')}>
        {REMOTE_PERMISSIONS.map((p) => (
          <button key={p} type="button" className={`chip ${moderator.permissions.includes(p) ? 'active' : ''}`} aria-pressed={moderator.permissions.includes(p)} title={t(`remote.permHint.${p}`)} onClick={() => toggle(p)}>
            {t(`remote.perm.${p}`)}
          </button>
        ))}
      </div>
    </li>
  );
}
