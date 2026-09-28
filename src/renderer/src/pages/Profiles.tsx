import { useEffect, useState } from 'react';
import { Icon } from '../components/icons';
import { Button, Card, PageHeader, TextInput, Toggle } from '../components/ui';
import { useT } from '../i18n';
import { OVERLAYS } from '../overlayCatalog';
import { navigate, profileAction, useApp } from '../store';

export function Profiles() {
  const t = useT();
  const profiles = useApp((d) => d.settings!.profiles);
  const activeId = useApp((d) => d.settings!.activeProfileId);
  const active = (profiles.find((p) => p.id === activeId) ?? profiles[0])!;
  const [newName, setNewName] = useState('');
  const [editName, setEditName] = useState(active?.name ?? '');
  useEffect(() => setEditName(active?.name ?? ''), [activeId, active?.name]);
  const create = async () => {
    if (await profileAction('profiles:create', newName.trim() || `${active.name} ${profiles.length + 1}`)) setNewName('');
  };
  return (
    <div className="page page-wide">
      <PageHeader title={t('nav.profiles')} subtitle={t('profiles.subtitle')} />
      <p className="muted small">{t('profiles.hint')}</p>
      <div className="profile-layout">
        <Card title={t('nav.profiles')}>
          <div className="profile-list">
            {profiles.map((p) => <button key={p.id} type="button" className={`profile-item ${p.id === activeId ? 'active' : ''}`} onClick={() => void profileAction('profiles:activate', p.id)}>
              <strong>{p.name}</strong>
              {p.id === activeId && <span className="pill">{t('profiles.active')}</span>}
            </button>)}
          </div>
          <div className="row-gap profile-create">
            <TextInput value={newName} onChange={setNewName} placeholder={t('profiles.newName')} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
            <Button icon="plus" onClick={() => void create()}>{t('profiles.create')}</Button>
          </div>
        </Card>
        <div className="profile-content">
          <Card title={`${t('profiles.active')}: ${active.name}`}>
            <div className="row-gap wrap">
              <TextInput value={editName} onChange={setEditName} onKeyDown={(e) => { if (e.key === 'Enter') void profileAction('profiles:rename', active.id, editName); }} />
              <Button icon="edit" disabled={!editName.trim() || editName.trim() === active.name} onClick={() => void profileAction('profiles:rename', active.id, editName)}>{t('profiles.rename')}</Button>
              <Button variant="danger" icon="trash" disabled={profiles.length < 2} onClick={() => { if (window.confirm(t('profiles.deleteConfirm'))) void profileAction('profiles:delete', active.id); }}>{t('profiles.delete')}</Button>
            </div>
          </Card>
          <Card title={t('profiles.overlays')}>
            <p className="muted small">{t('profiles.overlayHint')}</p>
            <div className="profile-overlays">
              {OVERLAYS.map((overlay) => <div key={overlay.kind} className="profile-overlay-item">
                <Icon name={overlay.icon} size={16} />
                <span>{t(`ov.${overlay.kind}`)}</span>
                <Toggle checked={active.overlays.includes(overlay.kind)} onChange={(enabled) => void profileAction('profiles:overlay', active.id, overlay.kind, enabled)} />
              </div>)}
            </div>
          </Card>
          <div className="profile-links">
            {([
              ['overlays', 'profiles.overlays', 'layers'],
              ['alerts', 'profiles.alerts', 'alert'],
              ['interactive', 'profiles.interactive', 'sparkle'],
              ['obs', 'profiles.actions', 'video'],
              ['bot', 'profiles.bot', 'bot'],
            ] as const).map(([page, label, icon]) =>
              <Card key={page} title={t(label)}><Button icon={icon} onClick={() => navigate(page)}>{t(label)} →</Button></Card>)}
          </div>
        </div>
      </div>
    </div>
  );
}
