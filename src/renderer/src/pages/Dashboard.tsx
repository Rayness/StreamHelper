import { useEffect, useRef, useState } from 'react';
import type { Category } from '@shared/types';
import { Button, Card } from '../components/ui';
import { useT } from '../i18n';
import { call, callOk, useApp } from '../store';

export function StreamCard() {
  const t = useT();
  const stream = useApp((d) => d.state!.stream);
  const connected = useApp((d) => d.state!.twitch.status === 'connected');
  const [title, setTitle] = useState(stream.title);
  const [category, setCategory] = useState<Category | null>(null);
  const [query, setQuery] = useState(stream.categoryName);
  const [results, setResults] = useState<Category[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow remote changes (e.g. !title from chat) unless the user is editing.
  const dirty = title !== stream.title || (category && category.id !== stream.categoryId);
  useEffect(() => {
    if (!dirty) {
      setTitle(stream.title);
      setQuery(stream.categoryName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.title, stream.categoryName]);
  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  const search = (q: string) => {
    setQuery(q);
    setOpen(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) return setResults([]);
    searchTimer.current = setTimeout(async () => setResults((await call('twitch:searchCategories', q)) ?? []), 300);
  };

  const save = async () => {
    setSaving(true);
    const ok = await callOk('twitch:updateStream', { title, ...(category ? { categoryId: category.id } : {}) });
    setSaving(false);
    // Keep the picked category on failure so "Save" can simply be pressed again.
    if (ok) setCategory(null);
  };

  if (!connected) {
    return (
      <Card icon="broadcast" title={t('dash.stream')}>
        <p className="muted">{t('dash.connectTwitch')}</p>
      </Card>
    );
  }
  return (
    <Card icon="broadcast" title={t('dash.stream')}>
      <label className="field">
        <span className="field-label">{t('dash.title')}</span>
        <input
          className="input"
          value={title}
          maxLength={140}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && dirty && !saving && void save()}
        />
      </label>
      <label className="field combo">
        <span className="field-label">{t('dash.category')}</span>
        <input
          className="input"
          value={query}
          onChange={(e) => search(e.target.value)}
          onFocus={() => query && search(query)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {open && results.length > 0 && (
          <ul className="combo-list">
            {results.map((c) => (
              <li
                key={c.id}
                onMouseDown={() => {
                  setCategory(c);
                  setQuery(c.name);
                  setOpen(false);
                }}
              >
                {c.boxArtUrl && <img src={c.boxArtUrl} alt="" />}
                {c.name}
              </li>
            ))}
          </ul>
        )}
      </label>
      <div className="card-footer">
        {dirty && (
          <Button
            variant="ghost"
            onClick={() => {
              setTitle(stream.title);
              setQuery(stream.categoryName);
              setCategory(null);
            }}
          >
            {t('common.cancel')}
          </Button>
        )}
        <Button variant="primary" icon="check" disabled={!dirty || saving} onClick={() => void save()}>
          {t('dash.saveStream')}
        </Button>
      </div>
    </Card>
  );
}
