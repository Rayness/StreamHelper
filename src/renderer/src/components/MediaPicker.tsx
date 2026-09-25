import { useEffect, useState } from 'react';
import type { MediaFile } from '@shared/types';
import { useT } from '../i18n';
import { call } from '../store';
import { Icon } from './icons';
import { Button, IconButton } from './ui';

/** Pick an imported media file (sound / image / video) or import a new one into the app's media folder. */
export function MediaPicker({ value, onChange, kind }: { value: string | null; onChange: (v: string | null) => void; kind: 'audio' | 'visual' }) {
  const t = useT();
  const [files, setFiles] = useState<MediaFile[]>([]);
  useEffect(() => {
    void call('media:list').then((l) => l && setFiles(l));
  }, [value]);
  const matches = files.filter((f) => (kind === 'audio' ? f.kind === 'audio' : f.kind !== 'audio'));
  const current = files.find((f) => f.name === value);

  const importFile = async () => {
    const f = await call('media:import');
    if (!f) return;
    if ((kind === 'audio') !== (f.kind === 'audio')) return;
    setFiles((prev) => [...prev, f]);
    onChange(f.name);
  };

  return (
    <div className="media-picker">
      <div className="media-row">
        <span className="media-icon">
          <Icon name={kind === 'audio' ? 'music' : 'image'} size={16} />
        </span>
        <select className="input select" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">{kind === 'audio' ? t('media.defaultSound') : t('media.none')}</option>
          {matches.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
          {value && !current && <option value={value}>{value}</option>}
        </select>
        <Button size="sm" icon="plus" onClick={() => void importFile()}>
          {t('media.import')}
        </Button>
        {current && kind === 'audio' && <IconButton icon="play" label={t('media.preview')} onClick={() => void new Audio(current.url).play()} />}
      </div>
      {current && kind !== 'audio' && (
        <div className="media-preview">{current.kind === 'video' ? <video src={current.url} muted autoPlay loop /> : <img src={current.url} alt="" />}</div>
      )}
    </div>
  );
}
