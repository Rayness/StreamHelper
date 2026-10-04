import { useState } from 'react';
import { uid } from '@shared/defaults';
import { ALERT_TYPES, type BotCommand, type BotSettings, type BotTimer, type ModAction, type ModFilter, type Permission } from '@shared/types';
import { Button, Card, Empty, Field, IconButton, LinesInput, NumberInput, PageHeader, Select, Tabs, TextArea, TextInput, Toggle } from '../components/ui';
import { useT, type TFn } from '../i18n';
import { navigate, saveSettings, useApp, useSub } from '../store';

type Tab = 'commands' | 'builtins' | 'timers' | 'counters' | 'moderation' | 'events';
const TABS: Tab[] = ['commands', 'builtins', 'timers', 'counters', 'moderation', 'events'];
const PERMISSIONS: Permission[] = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'];

const permOptions = (t: TFn) => PERMISSIONS.map((p) => ({ value: p, label: t(`perm.${p}`) }));

export function Bot() {
  const t = useT();
  const bot = useApp((d) => d.settings!.bot);
  const [tab, setTab] = useSub<Tab>('bot', 'commands', TABS);
  const save = (patch: Partial<BotSettings>) => saveSettings('bot', { ...bot, ...patch });
  return (
    <div className="page">
      <PageHeader
        title={t('nav.bot')}
        subtitle={t('bot.subtitle')}
        actions={
          <>
            <Field label={t('bot.prefix')}>
              <input className="input prefix-input" value={bot.prefix} maxLength={3} onChange={(e) => save({ prefix: e.target.value })} />
            </Field>
            <Toggle checked={bot.enabled} onChange={(enabled) => save({ enabled })} label={bot.enabled ? t('bot.on') : t('bot.off')} />
          </>
        }
      />
      <Button size="sm" icon="plug" onClick={() => navigate('connections','twitch')}>{t('conn.twitchBot')}</Button>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'commands', label: t('bot.tabCommands') },
          { id: 'builtins', label: t('bot.tabBuiltins') },
          { id: 'timers', label: t('bot.tabTimers') },
          { id: 'counters', label: t('bot.tabCounters') },
          { id: 'moderation', label: t('bot.tabModeration') },
          { id: 'events', label: t('bot.tabEvents') },
        ]}
      />
      {tab === 'commands' && <Commands bot={bot} save={save} />}
      {tab === 'builtins' && <Builtins bot={bot} save={save} />}
      {tab === 'timers' && <Timers bot={bot} save={save} />}
      {tab === 'counters' && <Counters bot={bot} save={save} />}
      {tab === 'moderation' && <Moderation bot={bot} save={save} />}
      {tab === 'events' && <EventMessages bot={bot} save={save} />}
    </div>
  );
}

interface SectionProps {
  bot: BotSettings;
  save: (patch: Partial<BotSettings>) => void;
}

function Commands({ bot, save }: SectionProps) {
  const t = useT();
  const update = (id: string, patch: Partial<BotCommand>) => save({ commands: bot.commands.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const add = () =>
    save({
      commands: [
        { id: uid('cmd_'), enabled: true, trigger: '', aliases: [], response: '', permission: 'everyone', cooldownSec: 10, userCooldownSec: 0, reply: false },
        ...bot.commands,
      ],
    });
  const triggers = bot.commands.map((c) => c.trigger.toLowerCase()).filter(Boolean);
  return (
    <>
      <Card>
        <p className="muted small vars-help">{t('bot.varsHelp')}</p>
      </Card>
      <div className="toolbar">
        <Button variant="primary" icon="plus" onClick={add}>
          {t('bot.addCommand')}
        </Button>
      </div>
      {bot.commands.length === 0 && <Empty icon="bot" title={t('bot.noCommands')} />}
      {bot.commands.map((c) => {
        const dup = c.trigger && triggers.filter((x) => x === c.trigger.toLowerCase()).length > 1;
        return (
          <Card key={c.id} className={`command ${c.enabled ? '' : 'disabled'}`}>
            <div className="command-head">
              <Toggle checked={c.enabled} onChange={(enabled) => update(c.id, { enabled })} />
              <div className="trigger">
                <span className="prefix">{bot.prefix}</span>
                <input
                  className={`input mono ${dup ? 'invalid' : ''}`}
                  value={c.trigger}
                  placeholder={t('bot.triggerPh')}
                  onChange={(e) => update(c.id, { trigger: e.target.value.replace(/\s+/g, '').replace(bot.prefix, '') })}
                />
              </div>
              <Select<Permission> value={c.permission} onChange={(permission) => update(c.id, { permission })} options={permOptions(t)} />
              <IconButton icon="trash" label={t('common.delete')} variant="danger" onClick={() => confirm(t('common.confirmDelete')) && save({ commands: bot.commands.filter((x) => x.id !== c.id) })} />
            </div>
            <TextArea value={c.response} onChange={(response) => update(c.id, { response })} rows={2} placeholder={t('bot.responsePh')} />
            <div className="form compact">
              <Field label={t('bot.aliases')} hint={t('bot.aliasesHint')}>
                <TextInput value={c.aliases.join(', ')} onChange={(v) => update(c.id, { aliases: v.split(',').map((a) => a.trim().replace(/^\W/, '')).filter(Boolean) })} />
              </Field>
              <Field label={t('bot.cooldown')}>
                <NumberInput value={c.cooldownSec} min={0} onChange={(cooldownSec) => update(c.id, { cooldownSec })} />
              </Field>
              <Field label={t('bot.userCooldown')}>
                <NumberInput value={c.userCooldownSec} min={0} onChange={(userCooldownSec) => update(c.id, { userCooldownSec })} />
              </Field>
              <Field label={t('bot.reply')}>
                <Toggle checked={c.reply} onChange={(reply) => update(c.id, { reply })} />
              </Field>
            </div>
            {dup && <p className="error small">{t('bot.duplicate')}</p>}
          </Card>
        );
      })}
    </>
  );
}

function Builtins({ bot, save }: SectionProps) {
  const t = useT();
  return (
    <Card>
      <table className="table">
        <thead>
          <tr>
            <th />
            <th>{t('bot.command')}</th>
            <th>{t('bot.description')}</th>
            <th>{t('bot.permission')}</th>
          </tr>
        </thead>
        <tbody>
          {bot.builtins.map((b) => {
            const update = (patch: Partial<typeof b>) => save({ builtins: bot.builtins.map((x) => (x.id === b.id ? { ...x, ...patch } : x)) });
            return (
              <tr key={b.id} className={b.enabled ? '' : 'disabled'}>
                <td>
                  <Toggle checked={b.enabled} onChange={(enabled) => update({ enabled })} />
                </td>
                <td>
                  <div className="trigger">
                    <span className="prefix">{bot.prefix}</span>
                    <input className="input mono" value={b.trigger} onChange={(e) => update({ trigger: e.target.value.replace(/\s+/g, '') })} />
                  </div>
                </td>
                <td className="muted small">{t(`builtin.${b.id}`)}</td>
                <td>
                  <Select<Permission> value={b.permission} onChange={(permission) => update({ permission })} options={permOptions(t)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function Timers({ bot, save }: SectionProps) {
  const t = useT();
  const update = (id: string, patch: Partial<BotTimer>) => save({ timers: bot.timers.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  return (
    <>
      <div className="toolbar">
        <Button
          variant="primary"
          icon="plus"
          onClick={() => save({ timers: [...bot.timers, { id: uid('tmr_'), enabled: true, name: '', messages: [], intervalMin: 15, minChatLines: 5, onlyWhenLive: true }] })}
        >
          {t('bot.addTimer')}
        </Button>
      </div>
      <p className="muted small">{t('bot.timersHint')}</p>
      {bot.timers.length === 0 && <Empty icon="clock" title={t('bot.noTimers')} />}
      {bot.timers.map((tm) => (
        <Card key={tm.id} className={tm.enabled ? '' : 'disabled'}>
          <div className="command-head">
            <Toggle checked={tm.enabled} onChange={(enabled) => update(tm.id, { enabled })} />
            <input className="input" value={tm.name} placeholder={t('bot.timerName')} onChange={(e) => update(tm.id, { name: e.target.value })} />
            <IconButton icon="trash" label={t('common.delete')} variant="danger" onClick={() => confirm(t('common.confirmDelete')) && save({ timers: bot.timers.filter((x) => x.id !== tm.id) })} />
          </div>
          <Field label={t('bot.timerMessages')} hint={t('bot.timerMessagesHint')} wide>
            <LinesInput value={tm.messages} onChange={(messages) => update(tm.id, { messages })} rows={3} />
          </Field>
          <div className="form compact">
            <Field label={t('bot.interval')}>
              <NumberInput value={tm.intervalMin} min={1} max={240} onChange={(intervalMin) => update(tm.id, { intervalMin })} />
            </Field>
            <Field label={t('bot.minLines')}>
              <NumberInput value={tm.minChatLines} min={0} onChange={(minChatLines) => update(tm.id, { minChatLines })} />
            </Field>
            <Field label={t('bot.onlyLive')}>
              <Toggle checked={tm.onlyWhenLive} onChange={(onlyWhenLive) => update(tm.id, { onlyWhenLive })} />
            </Field>
          </div>
        </Card>
      ))}
    </>
  );
}

function Counters({ bot, save }: SectionProps) {
  const t = useT();
  const [name, setName] = useState('');
  const entries = Object.entries(bot.counters);
  const set = (k: string, v: number) => save({ counters: { ...bot.counters, [k]: v } });
  return (
    <Card>
      <p className="muted small">{t('bot.countersHint', { prefix: bot.prefix })}</p>
      <div className="counter-add">
        <TextInput value={name} onChange={(v) => setName(v.replace(/[^\p{L}\p{N}_-]/gu, ''))} placeholder={t('bot.counterName')} />
        <Button
          icon="plus"
          disabled={!name || name in bot.counters}
          onClick={() => {
            set(name, 0);
            setName('');
          }}
        >
          {t('common.add')}
        </Button>
      </div>
      {entries.length === 0 && <Empty icon="hash" title={t('bot.noCounters')} />}
      <ul className="counter-list">
        {entries.map(([k, v]) => (
          <li key={k}>
            <code>{`{count:${k}}`}</code>
            <div className="counter-ctl">
              <IconButton icon="minus" label="-1" onClick={() => set(k, v - 1)} />
              <NumberInput value={v} onChange={(n) => set(k, n)} />
              <IconButton icon="plus" label="+1" onClick={() => set(k, v + 1)} />
            </div>
            <IconButton
              icon="trash"
              label={t('common.delete')}
              variant="danger"
              onClick={() => {
                const next = { ...bot.counters };
                delete next[k];
                save({ counters: next });
              }}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function FilterCard({ title, hint, filter, onChange, children }: { title: string; hint: string; filter: ModFilter; onChange: (f: ModFilter) => void; children?: React.ReactNode }) {
  const t = useT();
  return (
    <Card className={filter.enabled ? '' : 'disabled'} title={title} actions={<Toggle checked={filter.enabled} onChange={(enabled) => onChange({ ...filter, enabled })} />}>
      <p className="muted small">{hint}</p>
      <div className="form compact">
        <Field label={t('mod.action')}>
          <Select<ModAction>
            value={filter.action}
            onChange={(action) => onChange({ ...filter, action })}
            options={(['delete', 'timeout', 'ban', 'warn'] as const).map((a) => ({ value: a, label: t(`modAction.${a}`) }))}
          />
        </Field>
        {filter.action === 'timeout' && (
          <Field label={t('mod.timeoutSec')}>
            <NumberInput value={filter.timeoutSec} min={1} max={1209600} onChange={(timeoutSec) => onChange({ ...filter, timeoutSec })} />
          </Field>
        )}
        <Field label={t('mod.warning')} hint={t('mod.warningHint')} wide>
          <TextInput value={filter.warning} onChange={(warning) => onChange({ ...filter, warning })} />
        </Field>
        {children}
      </div>
    </Card>
  );
}

function Moderation({ bot, save }: SectionProps) {
  const t = useT();
  const m = bot.moderation;
  const set = (patch: Partial<typeof m>) => save({ moderation: { ...m, ...patch } });
  return (
    <>
      <Card>
        <div className="form compact">
          <Field label={t('mod.exempt')} hint={t('mod.exemptHint')}>
            <Select<Permission> value={m.exempt} onChange={(exempt) => set({ exempt })} options={permOptions(t).filter((p) => p.value !== 'everyone')} />
          </Field>
          <Field label={t('mod.permitSec')} hint={t('mod.permitHint', { prefix: bot.prefix })}>
            <NumberInput value={m.permitSec} min={10} max={3600} onChange={(permitSec) => set({ permitSec })} />
          </Field>
        </div>
      </Card>
      <div className="two-col">
        <FilterCard title={t('mod.links')} hint={t('mod.linksHint')} filter={m.links} onChange={(f) => set({ links: { ...m.links, ...f } })}>
          <Field label={t('mod.allowed')} hint={t('mod.allowedHint')} wide>
            <LinesInput value={m.links.allowed} onChange={(allowed) => set({ links: { ...m.links, allowed } })} rows={3} />
          </Field>
        </FilterCard>
        <FilterCard title={t('mod.words')} hint={t('mod.wordsHint')} filter={m.words} onChange={(f) => set({ words: { ...m.words, ...f } })}>
          <Field label={t('mod.wordList')} wide>
            <LinesInput value={m.words.list} onChange={(list) => set({ words: { ...m.words, list } })} rows={3} />
          </Field>
        </FilterCard>
        <FilterCard title={t('mod.caps')} hint={t('mod.capsHint')} filter={m.caps} onChange={(f) => set({ caps: { ...m.caps, ...f } })}>
          <Field label={t('mod.capsMin')}>
            <NumberInput value={m.caps.minLength} min={1} onChange={(minLength) => set({ caps: { ...m.caps, minLength } })} />
          </Field>
          <Field label={t('mod.capsPercent')}>
            <NumberInput value={m.caps.percent} min={1} max={100} onChange={(percent) => set({ caps: { ...m.caps, percent } })} />
          </Field>
        </FilterCard>
        <FilterCard title={t('mod.spam')} hint={t('mod.spamHint')} filter={m.spam} onChange={(f) => set({ spam: { ...m.spam, ...f } })}>
          <Field label={t('mod.maxRepeats')}>
            <NumberInput value={m.spam.maxRepeats} min={0} onChange={(maxRepeats) => set({ spam: { ...m.spam, maxRepeats } })} />
          </Field>
          <Field label={t('mod.maxEmotes')}>
            <NumberInput value={m.spam.maxEmotes} min={0} onChange={(maxEmotes) => set({ spam: { ...m.spam, maxEmotes } })} />
          </Field>
          <Field label={t('mod.maxLength')}>
            <NumberInput value={m.spam.maxLength} min={0} max={500} onChange={(maxLength) => set({ spam: { ...m.spam, maxLength } })} />
          </Field>
        </FilterCard>
      </div>
    </>
  );
}

function EventMessages({ bot, save }: SectionProps) {
  const t = useT();
  return (
    <Card>
      <p className="muted small">{t('bot.eventsHint')}</p>
      <div className="form">
        {ALERT_TYPES.map((type) => (
          <Field key={type} label={t(`alertType.${type}`)} wide>
            <TextInput
              value={bot.eventMessages[type] ?? ''}
              placeholder={t('bot.eventOff')}
              onChange={(v) => save({ eventMessages: { ...bot.eventMessages, [type]: v } })}
            />
          </Field>
        ))}
      </div>
    </Card>
  );
}
