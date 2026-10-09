import { useState } from 'react';
import { uid } from '@shared/defaults';
import { resolveStreamVar, VARIABLE_NAME } from '@shared/vars';
import type { CustomVariable } from '@shared/types';
import { Icon } from '../components/icons';
import { Button, Card, IconButton, NumberInput, TextInput } from '../components/ui';
import { useNow } from '../hooks';
import { useT, type TKey } from '../i18n';
import { call, getData, saveSettings, useApp } from '../store';

type Scope = 'all' | 'bot' | 'alerts';
interface VarDef { token: string; name: string; arg?: string; scope: Scope }
interface VarGroup { id: string; vars: VarDef[] }

const v = (token: string, scope: Scope = 'all'): VarDef => {
  const [name, arg] = token.split(':');
  return { token, name, arg, scope };
};

/** Every built-in variable, by topic. `scope` says where it works: everywhere, chat bot, or alerts. */
const GROUPS: VarGroup[] = [
  { id: 'stream', vars: ['title', 'game', 'viewers', 'uptime', 'channel'].map((x) => v(x)) },
  { id: 'stats', vars: ['lastfollower', 'lastsub', 'lastcheerer', 'lastcheer', 'topcheerer', 'topcheer', 'lastraider', 'lastraid', 'follows', 'subs', 'bits'].map((x) => v(x)) },
  { id: 'donations', vars: ['lastdonor', 'lastdonation', 'topdonor', 'topdonation', 'donations', 'donationcount', 'lastdonations:3', 'topdonors:3', 'alltimetop:3'].map((x) => v(x)) },
  { id: 'time', vars: ['time', 'date'].map((x) => v(x)) },
  { id: 'kawaki', vars: ['anime', 'episode', 'animeurl', 'kawaki'].map((x) => v(x)) },
  { id: 'bot', vars: ['user', 'touser', 'args', 'arg:1', 'random:1-100', 'followage', 'count+:deaths', 'count-:deaths'].map((x) => v(x, 'bot')) },
  { id: 'alerts', vars: ['user', 'amount', 'currency', 'message', 'months', 'tier', 'count', 'reward'].map((x) => v(x, 'alerts')) },
];

function useCopy(): [string | null, (text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  return [copied, (text: string) => { void call('clipboard:write', text); setCopied(text); setTimeout(() => setCopied((c) => (c === text ? null : c)), 1300); }];
}

export function Variables() {
  const t = useT();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  return (
    <div className="workspace variables-page">
      <header className="workspace-header">
        <div><h1>{t('nav.variables')}</h1><p className="muted small">{t('vars.hint')}</p></div>
        <div className="variables-search"><Icon name="search" size={15} /><input className="input" value={query} placeholder={t('common.search')} onChange={(e) => setQuery(e.target.value)} /></div>
      </header>
      <div className="variables-layout">
        <div className="stack-lg">
          <CustomVariables query={q} />
          <Counters query={q} />
        </div>
        <BuiltinVariables query={q} />
      </div>
    </div>
  );
}

function CustomVariables({ query }: { query: string }) {
  const t = useT();
  const list = useApp((d) => d.settings!.variables);
  const [copied, copy] = useCopy();
  const save = (next: CustomVariable[]) => saveSettings('variables', next);
  const update = (id: string, patch: Partial<CustomVariable>) => save(getData().settings!.variables.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const add = () => {
    let n = list.length + 1;
    while (list.some((x) => x.name === `var${n}`)) n++;
    save([...list, { id: uid('var_'), name: `var${n}`, value: '', description: '' }]);
  };
  const names = list.map((x) => x.name.trim().toLowerCase());
  const shown = list.filter((x) => !query || `${x.name} ${x.value} ${x.description}`.toLowerCase().includes(query));
  return (
    <Card title={t('vars.custom')} icon="braces" actions={<Button size="sm" icon="plus" onClick={add}>{t('vars.add')}</Button>}>
      <p className="muted small">{t('vars.customHint')}</p>
      {!list.length && <p className="muted">{t('vars.customEmpty')}</p>}
      <div className="var-rows">
        {shown.map((x) => {
          const valid = VARIABLE_NAME.test(x.name.trim());
          const dup = names.filter((n) => n === x.name.trim().toLowerCase()).length > 1;
          return (
            <div key={x.id} className="var-row">
              <div className="var-name">
                <span className="var-brace">{'{'}</span>
                <input className={`input mono ${valid && !dup ? '' : 'invalid'}`} value={x.name} spellCheck={false} aria-label={t('vars.name')} onChange={(e) => update(x.id, { name: e.target.value.replace(/\s+/g, '_') })} />
                <span className="var-brace">{'}'}</span>
              </div>
              <TextInput value={x.value} onChange={(value) => update(x.id, { value })} placeholder={t('vars.value')} />
              <TextInput value={x.description} onChange={(description) => update(x.id, { description })} placeholder={t('vars.description')} />
              <IconButton icon={copied === `{${x.name}}` ? 'check' : 'copy'} label={t('common.copy')} onClick={() => copy(`{${x.name}}`)} />
              <IconButton icon="trash" label={t('common.delete')} onClick={() => confirm(t('common.confirmDelete')) && save(getData().settings!.variables.filter((y) => y.id !== x.id))} />
              {(!valid || dup) && <span className="error small var-error">{dup ? t('vars.duplicate') : t('vars.badName')}</span>}
            </div>
          );
        })}
      </div>
      <p className="muted small">{t('vars.actionHint')}</p>
    </Card>
  );
}

function Counters({ query }: { query: string }) {
  const t = useT();
  const bot = useApp((d) => d.settings!.bot);
  const [name, setName] = useState('');
  const [copied, copy] = useCopy();
  const counters = Object.entries(bot.counters).filter(([k]) => !query || k.toLowerCase().includes(query));
  const setValue = (key: string, value: number) => void call('counter:add', key, value - (getData().settings!.bot.counters[key] ?? 0));
  const remove = (key: string) => {
    const b = getData().settings!.bot;
    const next = { ...b.counters };
    delete next[key];
    saveSettings('bot', { ...b, counters: next });
  };
  const clean = name.trim().replace(/\s+/g, '');
  return (
    <Card title={t('vars.counters')} icon="hash">
      <p className="muted small">{t('vars.countersHint', { prefix: bot.prefix })}</p>
      <div className="var-rows">
        {counters.map(([key, value]) => (
          <div key={key} className="var-row counter">
            <code className="var-token">{`{count:${key}}`}</code>
            <NumberInput value={value} onChange={(n) => setValue(key, n)} />
            <Button size="sm" icon="minus" onClick={() => void call('counter:add', key, -1)} aria-label="-1" />
            <Button size="sm" icon="plus" onClick={() => void call('counter:add', key, 1)} aria-label="+1" />
            <IconButton icon={copied === `{count:${key}}` ? 'check' : 'copy'} label={t('common.copy')} onClick={() => copy(`{count:${key}}`)} />
            <IconButton icon="trash" label={t('common.delete')} onClick={() => confirm(t('common.confirmDelete')) && remove(key)} />
          </div>
        ))}
      </div>
      <div className="row-gap">
        <TextInput value={name} onChange={setName} placeholder={t('vars.counterName')} onKeyDown={(e) => { if (e.key === 'Enter' && clean) { void call('counter:add', clean, 0); setName(''); } }} />
        <Button icon="plus" disabled={!clean || clean in bot.counters} onClick={() => { void call('counter:add', clean, 0); setName(''); }}>{t('vars.addCounter')}</Button>
      </div>
    </Card>
  );
}

function BuiltinVariables({ query }: { query: string }) {
  const t = useT();
  const settings = useApp((d) => d.settings!);
  const state = useApp((d) => d.state!);
  const now = useNow(1000);
  const [copied, copy] = useCopy();
  const value = (d: VarDef) => {
    if (d.scope !== 'all') return null;
    const out = resolveStreamVar(d.name, d.arg, settings, state, now);
    return out === undefined || out === '' ? '—' : String(out);
  };
  const groups = GROUPS.map((g) => ({ ...g, vars: g.vars.filter((d) => !query || `${d.token} ${t(`vars.d.${d.name}` as TKey)}`.toLowerCase().includes(query)) })).filter((g) => g.vars.length);
  return (
    <div className="stack-lg">
      {groups.map((g) => (
        <Card key={g.id} title={t(`vars.group.${g.id}` as TKey)}>
          {g.id === 'bot' && <p className="muted small">{t('vars.botOnly')}</p>}
          {g.id === 'alerts' && <p className="muted small">{t('vars.alertsOnly')}</p>}
          <table className="var-table">
            <tbody>
              {g.vars.map((d) => {
                const token = `{${d.token}}`;
                const current = value(d);
                return (
                  <tr key={d.token}>
                    <td><button type="button" className="var-token" title={t('common.copy')} onClick={() => copy(token)}>{copied === token ? <><Icon name="check" size={13} />{t('common.copied')}</> : token}</button></td>
                    <td className="muted">{t(`vars.d.${d.name}` as TKey)}</td>
                    <td className="var-value" title={current ?? ''}>{current}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}
