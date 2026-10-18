import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AlertType } from '@shared/types';
import { buildSceneDocument, newEventScene, normalizeEventScene, normalizeEventStudio, scenePresets, SCENE_EVENT_TYPES, type EventScene, type EventStudioSettings, type SceneEventData } from '@shared/eventStudio';
import type { SceneAiConfig, SceneAiStatus } from '@shared/sceneAi';
import { OverlayBar } from '../components/overlay';
import { MediaPicker } from '../components/MediaPicker';
import { Button, Card, CopyField, Field, NumberInput, PageHeader, Select, TextInput, Toggle } from '../components/ui';
import { call, clearScenePreview, getData, registerNavigationGuard, saveSettings, useApp } from '../store';
import '../event-studio.css';

type Tab = 'html' | 'css' | 'js' | 'settings' | 'bindings' | 'ai';
type McpStatus = { enabled: boolean; running: boolean; port: number; url: string; token: string; error?: string };
type Pending = { scene: EventScene; params: string; baseline: string };
const pendingByProfile = new Map<string, Pending>();
function recoveryKey(profileId: string) { return `streamhelper:scene-draft:${profileId}`; }
function readRecovery(profileId: string): Pending | undefined {
  const cached = pendingByProfile.get(profileId);
  if (cached) return cached;
  try {
    const value = JSON.parse(localStorage.getItem(recoveryKey(profileId)) ?? 'null') as Pending | null;
    if (value && typeof value.params === 'string' && typeof value.baseline === 'string') return { ...value, scene: normalizeEventScene(value.scene) };
  } catch { /* An invalid recovery entry must not block opening the editor. */ }
  return undefined;
}
const eventNames = {
  ru: { follow: 'Фолловер', sub: 'Подписка', resub: 'Продление', giftsub: 'Подарочные подписки', cheer: 'Битсы', raid: 'Рейд', donation: 'Донат', redemption: 'Награда' },
  en: { follow: 'Follow', sub: 'Subscription', resub: 'Resubscription', giftsub: 'Gift subscriptions', cheer: 'Bits', raid: 'Raid', donation: 'Donation', redemption: 'Redemption' },
};
const signature = (scene: EventScene | null) => scene ? JSON.stringify(scene) : '';
const makeId = () => `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The editor keeps its own working copy; only explicit actions write profile settings. */
export function EventStudio() {
  const alerts = useApp((d) => d.settings!.alerts);
  const profileId = useApp((d) => d.settings!.activeProfileId);
  const language = useApp((d) => d.settings!.language);
  const currency = useApp((d) => d.settings!.currency);
  const overlayUrl = useApp((d) => d.state!.overlayUrl);
  const remote = useApp((d) => d.remote);
  const mcpPreview = useApp((d) => d.scenePreview);
  const ru = language === 'ru';
  const tr = (a: string, b: string) => ru ? a : b;
  const studio = useMemo(() => normalizeEventStudio(alerts.studio), [alerts.studio]);
  const [scene, setScene] = useState<EventScene | null>(() => readRecovery(profileId)?.scene ?? studio.scenes[0] ?? null);
  const [baseline, setBaseline] = useState(() => readRecovery(profileId)?.baseline ?? signature(scene));
  const [params, setParams] = useState(() => readRecovery(profileId)?.params ?? JSON.stringify(scene?.parameters ?? {}, null, 2));
  const [tab, setTab] = useState<Tab>('html');
  const [notice, setNotice] = useState(() => readRecovery(profileId) ? tr('Восстановлены несохранённые изменения этого профиля.', 'Unsaved changes for this profile have been restored.') : '');
  const [preview, setPreview] = useState<{ scene: EventScene; event: SceneEventData; id: string; muted: boolean } | null>(null);
  const [runtime, setRuntime] = useState('');
  const [runtimeError, setRuntimeError] = useState('');
  const [muted, setMuted] = useState(true);
  const [sample, setSample] = useState<SceneEventData>({ id: 'studio-sample', type: 'donation', user: 'StreamHelper', amount: 1000, currency, message: ru ? 'Спасибо за стрим!' : 'Thanks for the stream!', count: 5, viewers: 42, months: 12, tier: '1000', anonymous: false, source: 'test' });
  const [ai, setAi] = useState<SceneAiStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [keyAction, setKeyAction] = useState<'preserve' | 'replace' | 'remove'>('preserve');
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [aiCandidate, setAiCandidate] = useState<EventScene | null>(null);
  const aiCandidateBaseline = useRef({ scene: '', params: '' });
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [mcpPort, setMcpPort] = useState(16347);
  const frame = useRef<HTMLIFrameElement>(null);
  const previewDocument = useRef('');
  const box = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(500);
  const generation = useRef(0);
  const profile = useRef(profileId);
  const [loadedProfile, setLoadedProfile] = useState(profileId);
  const current = useRef({ scene, params, baseline, profileId });
  current.current = { scene, params, baseline, profileId };
  const dirty = !!scene && (signature(scene) !== baseline || params !== JSON.stringify(scene.parameters, null, 2));
  let parameterError = '';
  let parsedParams: EventScene['parameters'] = {};
  try {
    const value: unknown = JSON.parse(params);
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some((v) => !['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v))) throw new Error();
    parsedParams = value as EventScene['parameters'];
  } catch { parameterError = tr('Параметры: нужен JSON-объект со строками, числами и boolean.', 'Parameters must be a JSON object with string, number and boolean values.'); }

  useEffect(() => {
    const observer = new ResizeObserver(() => setBoxWidth(box.current?.clientWidth ?? 500));
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'scene:frame-ready') { frame.current?.contentWindow?.postMessage({ type: 'scene:load', document: previewDocument.current }, '*'); return; }
      if (event.data?.type !== 'scene:runtime' || event.data.playbackId !== preview?.id) return;
      if (event.data.kind === 'error') setRuntimeError(String(event.data.message ?? 'Scene error'));
      else if (event.data.kind === 'ready' || event.data.kind === 'finished') setRuntime(event.data.kind);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [preview?.id]);
  useEffect(() => {
    if (profile.current === profileId) return;
    profile.current = profileId;
    setLoadedProfile(profileId);
    generation.current++;
    setGenerating(false); setAiCandidate(null); setPreview(null); setRuntime(''); setRuntimeError('');
    const pending = readRecovery(profileId);
    const next = pending?.scene ?? studio.scenes[0] ?? null;
    setScene(next); setBaseline(pending?.baseline ?? signature(next)); setParams(pending?.params ?? JSON.stringify(next?.parameters ?? {}, null, 2));
    setNotice(pending ? tr('Восстановлены несохранённые изменения этого профиля.', 'Unsaved changes for this profile have been restored.') : '');
  }, [profileId, studio, ru]);
  useEffect(() => {
    if (loadedProfile !== profileId) return;
    if (dirty && scene) {
      const value = { scene, params, baseline };
      pendingByProfile.set(profileId, value);
      try { localStorage.setItem(recoveryKey(profileId), JSON.stringify(value)); } catch { /* In-memory recovery remains available if storage is full. */ }
    } else {
      pendingByProfile.delete(profileId);
      try { localStorage.removeItem(recoveryKey(profileId)); } catch { /* Storage may be unavailable. */ }
    }
  }, [scene, params, baseline, dirty, profileId, loadedProfile]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    const unregister = registerNavigationGuard(() => !dirty || window.confirm(tr('Есть несохранённые изменения сцены. Покинуть редактор? Изменения можно восстановить при возвращении.', 'This scene has unsaved changes. Leave the editor? You can recover your changes when you return.')));
    return () => {
      window.removeEventListener('beforeunload', guard); unregister();
    };
  }, [dirty, ru]);
  useEffect(() => {
    if (remote) return;
    let active = true;
    void call('scene:ai:get').then((status) => { if (active && status) setAi(status); });
    void call('scene:mcp:status').then((status) => { if (active && status) { setMcp(status); setMcpPort(status.port); } });
    return () => { active = false; generation.current++; };
  }, [remote]);

  function select(next: EventScene | null, force = false) {
    if (!force && dirty && !window.confirm(tr('Отменить несохранённые изменения этой сцены?', 'Discard unsaved changes to this scene?'))) return;
    generation.current++; setGenerating(false); setAiCandidate(null);
    setScene(next); setBaseline(next && !force && !studio.scenes.some((item) => item.id === next.id) ? '' : signature(next)); setParams(JSON.stringify(next?.parameters ?? {}, null, 2));
    if (next && next.eventType !== 'any') setSample((value) => ({ ...value, type: next.eventType as AlertType }));
    setNotice(''); setPreview(null); setRuntime(''); setRuntimeError(''); pendingByProfile.delete(profileId);
  }
  function edit(patch: Partial<EventScene>) { if (scene) { setScene({ ...scene, ...patch }); setNotice(''); } }
  function updateStudio(update: (value: EventStudioSettings) => EventStudioSettings) {
    const live = getData().settings;
    if (!live || live.activeProfileId !== profileId) return false;
    saveSettings('alerts', { ...live.alerts, studio: update(normalizeEventStudio(live.alerts.studio)) });
    return true;
  }
  function materialize() {
    if (!scene || parameterError) return null;
    try { return normalizeEventScene({ ...scene, parameters: parsedParams, updatedAt: Date.now() }); }
    catch (error) { setNotice(String((error as Error).message)); return null; }
  }
  function save(publish: boolean) {
    const next = materialize();
    if (!next) { if (parameterError) setNotice(parameterError); return; }
    // Persisting a published scene as a draft must never alter its live document.
    const saved = { ...next, id: publish ? next.draftOf ?? next.id : next.published ? makeId() : next.id, published: publish, draftOf: publish ? undefined : next.draftOf ?? (next.published ? next.id : undefined) };
    if (!studio.scenes.some((item) => item.id === saved.id) && studio.scenes.length >= 100) { setNotice(tr('В библиотеке уже 100 сцен. Удалите ненужную сцену.', 'The library already has 100 scenes. Delete an unused scene first.')); return; }
    if (!updateStudio((value) => {
      const scenes = publish && next.draftOf ? value.scenes.filter((item) => item.id !== next.id) : value.scenes;
      return { ...value, scenes: scenes.some((item) => item.id === saved.id) ? scenes.map((item) => item.id === saved.id ? saved : item) : [...scenes, saved] };
    })) return;
    select(saved, true);
    setNotice(publish ? tr('Сцена опубликована. Назначьте её событиям во вкладке «Привязки».', 'Scene published. Assign it to events in Bindings.') : tr('Черновик сохранён. Эфирная сцена не изменена.', 'Draft saved. The live scene has not changed.'));
  }
  function restart(candidate = scene) {
    if (!candidate || parameterError && candidate === scene) { setRuntimeError(parameterError); return; }
    let checked: EventScene;
    try { checked = normalizeEventScene(candidate === scene ? { ...candidate, parameters: parsedParams } : candidate); }
    catch (error) { setRuntimeError(String((error as Error).message)); return; }
    setRuntime('loading'); setRuntimeError('');
    setPreview({ scene: checked, event: { ...sample, id: makeId() }, id: makeId(), muted });
  }
  function codeKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart, end = input.selectionEnd;
    const value = input.value.slice(0, start) + '  ' + input.value.slice(end);
    edit({ [tab]: value });
    requestAnimationFrame(() => { input.selectionStart = input.selectionEnd = start + 2; });
  }
  async function generate() {
    const input = materialize();
    if (!input || !prompt.trim()) return;
    const request = ++generation.current;
    const originProfile = profileId, originScene = scene!.id, originSignature = signature(scene), originParams = params;
    setGenerating(true); setAiCandidate(null); setNotice('');
    const result = await call('scene:ai:generate', { prompt, scene: input });
    if (request !== generation.current) return;
    setGenerating(false);
    if (getData().settings?.activeProfileId !== originProfile || current.current.scene?.id !== originScene || signature(current.current.scene) !== originSignature || current.current.params !== originParams) { setNotice(tr('Результат ИИ пропущен: сцена или профиль изменились.', 'AI result ignored because the scene or profile changed.')); return; }
    if (result) { aiCandidateBaseline.current = { scene: originSignature, params: originParams }; setAiCandidate(result); restart(result); setNotice(tr('Результат ИИ открыт в превью. Примените его к черновику после проверки.', 'AI result is in preview. Review it, then apply to your draft.')); }
  }
  const published = studio.scenes.filter((item) => item.published);
  const sceneOptions = [{ value: '', label: tr('Стандартный алерт', 'Standard alert') }, ...published.map((item) => ({ value: item.id, label: item.name }))];
  const donationOptions = [{ value: '', label: tr('Стандартный алерт', 'Standard alert') }, ...published.filter((item) => item.eventType === 'any' || item.eventType === 'donation').map((item) => ({ value: item.id, label: item.name }))];
  const sameCurrency = !sample.currency || sample.currency.toUpperCase() === currency.toUpperCase();
  const applicable = studio.donationLevels.filter((level) => sameCurrency && sample.amount >= level.minAmount && published.some((item) => item.id === level.sceneId && (item.eventType === 'any' || item.eventType === 'donation'))).sort((a, b) => b.minAmount - a.minAmount)[0];
  const donationSceneId = applicable?.sceneId || studio.bindings.donation;
  const donationScene = published.find((item) => item.id === donationSceneId && (item.eventType === 'any' || item.eventType === 'donation'));
  const doc = useMemo(() => preview ? buildSceneDocument(preview.scene, preview.event, { preview: true, muted: preview.muted, playbackId: preview.id, mediaBaseUrl: overlayUrl }) : '', [preview, overlayUrl]);
  previewDocument.current = doc;
  const scale = preview ? Math.min(boxWidth / preview.scene.width, 400 / preview.scene.height) : 1;
  if (remote) return null;

  return <div className="page event-studio" data-event-studio="true">
    <PageHeader title={tr('Студия событий', 'Event Scene Studio')} subtitle={tr('HTML, CSS и JavaScript для событий вашего стрима', 'HTML, CSS and JavaScript for your stream events')} actions={<span className="studio-local-badge">{tr('Локальный редактор', 'Local editor')}</span>} />
    <OverlayBar kind="alerts" name={tr('Сцены событий', 'Event scenes')} />
    {mcpPreview && <div className="studio-notice studio-actions"><span>{tr('MCP прислал сцену для проверки:', 'MCP sent a scene for review:')} {mcpPreview.scene.name}</span><Button data-studio-action="accept-mcp" onClick={() => {
      if (dirty && !window.confirm(tr('Заменить несохранённый черновик сценой из MCP?', 'Replace the unsaved draft with this MCP scene?'))) return;
      const liveOriginal = studio.scenes.find((item) => item.id === mcpPreview.scene.id && item.published);
      const next = { ...mcpPreview.scene, id: liveOriginal ? makeId() : mcpPreview.scene.id, published: false, draftOf: mcpPreview.scene.draftOf ?? liveOriginal?.id };
      select(next, true); setBaseline(''); setRuntime('loading'); setRuntimeError('');
      const event = mcpPreview.event ?? sample; setSample(event); setPreview({ scene: next, event, id: makeId(), muted }); clearScenePreview();
    }}>{tr('Открыть черновик и превью', 'Open draft and preview')}</Button><Button onClick={() => clearScenePreview()}>{tr('Отклонить', 'Dismiss')}</Button></div>}
    <div className="studio-topbar">
      <Toggle checked={studio.enabled} label={tr('Включить сцены в эфире', 'Enable live event scenes')} onChange={(enabled) => updateStudio((value) => ({ ...value, enabled }))} />
      <span className="muted small">{tr('В эфир попадают только опубликованные сцены с привязкой.', 'Only published scenes assigned to an event go live.')}</span>
    </div>
    <div className="studio-layout">
      <aside className="studio-library">
        <h3>{tr('Библиотека сцен', 'Scene library')} <span>{studio.scenes.length}</span></h3>
        <div className="studio-scene-list" aria-label={tr('Сцены', 'Scenes')}>
          {studio.scenes.map((item) => <button key={item.id} type="button" data-studio-scene={item.id} className={scene?.id === item.id ? 'active' : ''} onClick={() => select(item)}><strong>{item.name}</strong><span>{item.eventType === 'any' ? tr('Любое событие', 'Any event') : eventNames[language][item.eventType]} · {item.published ? tr('Опубликовано', 'Published') : tr('Черновик', 'Draft')}</span></button>)}
          {!studio.scenes.length && <p className="muted small">{tr('Начните с готового шаблона или пустой сцены.', 'Start with a preset or a blank scene.')}</p>}
        </div>
        <Button data-studio-action="blank" onClick={() => select({ ...newEventScene('any', language), html: '', css: '', js: '', parameters: {} })}>{tr('Пустая сцена', 'Blank scene')}</Button>
        <h4>{tr('Быстрый старт', 'Quick start')}</h4>
        <div className="studio-presets">{scenePresets(language).map((item, index) => <Button key={item.id} data-studio-preset={index} onClick={() => select({ ...item, id: makeId(), published: false })}>{item.name}</Button>)}</div>
      </aside>
      <section className="studio-workspace">
        <div className="studio-editor-head">
          <div><h2>{scene?.name ?? tr('Выберите шаблон', 'Choose a preset')}</h2><span className={`studio-state ${dirty ? 'dirty' : ''}`} data-studio-dirty={dirty}>{dirty ? tr('Несохранённые изменения', 'Unsaved changes') : scene?.published ? tr('Опубликовано', 'Published') : tr('Черновик', 'Draft')}</span></div>
          <div className="studio-actions">
            <Button data-studio-action="duplicate" disabled={!scene} onClick={() => scene && select({ ...scene, id: makeId(), name: `${scene.name} ${tr('(копия)', '(copy)')}`, published: false, draftOf: undefined })}>{tr('Копия', 'Duplicate')}</Button>
            <Button data-studio-action="delete" disabled={!scene || !studio.scenes.some((item) => item.id === scene.id)} variant="danger" onClick={() => { if (!scene || !window.confirm(tr('Удалить сцену и её привязки?', 'Delete this scene and its bindings?'))) return; const id = scene.id; updateStudio((value) => ({ ...value, scenes: value.scenes.filter((item) => item.id !== id), bindings: Object.fromEntries(Object.entries(value.bindings).filter(([, target]) => target !== id)), donationLevels: value.donationLevels.filter((level) => level.sceneId !== id) })); select(studio.scenes.find((item) => item.id !== id) ?? null, true); }}>{tr('Удалить', 'Delete')}</Button>
            <Button data-studio-action="save" disabled={!scene || !!parameterError} onClick={() => save(false)}>{tr('Сохранить черновик', 'Save draft')}</Button>
            <Button data-studio-action="publish" disabled={!scene || !!parameterError} variant="primary" onClick={() => save(true)}>{tr('Опубликовать', 'Publish')}</Button>
          </div>
        </div>
        {notice && <div className="studio-notice" role="status">{notice}</div>}
        <div className="tabs studio-tabs" role="tablist">{(['html', 'css', 'js', 'settings', 'bindings', 'ai'] as Tab[]).map((id) => <button type="button" role="tab" aria-selected={tab === id} data-studio-tab={id} key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{id === 'settings' ? tr('Настройки', 'Settings') : id === 'bindings' ? tr('Привязки', 'Bindings') : id === 'ai' ? tr('ИИ + MCP', 'AI + MCP') : id.toUpperCase()}</button>)}</div>
        <div className="studio-content-split">
          <div className="studio-edit-panel">
            {(['html', 'css', 'js'] as string[]).includes(tab) && (scene ? <><div className="studio-code-caption"><span>{scene.name}.{tab}</span><span>{tr('Tab — два пробела', 'Tab inserts two spaces')}</span></div><textarea aria-label={`${tab.toUpperCase()} code`} data-studio-code={tab} className="studio-code" value={scene[tab as 'html' | 'css' | 'js']} spellCheck={false} onKeyDown={codeKey} onChange={(event) => edit({ [tab]: event.target.value })} /><div className="studio-api-note"><code>scene.event · scene.params · scene.finish()</code><span>{tr('Поля события: data-field="user", "amount", "message", "count", "viewers". Медиа: /media/имя-файла.', 'Event text: data-field="user", "amount", "message", "count", "viewers". Media: /media/filename.')}</span></div></> : <div className="studio-empty">{tr('Создайте сцену из библиотеки слева.', 'Create a scene using the library.')}</div>)}
            {tab === 'settings' && scene && <Card title={tr('Параметры сцены', 'Scene settings')}><div className="form">
              <Field label={tr('Название', 'Name')} wide><input className="input" data-studio-field="name" value={scene.name} onChange={(event) => edit({ name: event.target.value })} /></Field>
              <Field label={tr('Тип события', 'Event type')}><Select value={scene.eventType} onChange={(eventType) => edit({ eventType })} options={[{ value: 'any', label: tr('Любое', 'Any') }, ...SCENE_EVENT_TYPES.map((value) => ({ value, label: eventNames[language][value] }))]} /></Field>
              <Field label={tr('Длительность, сек', 'Duration, seconds')}><NumberInput value={scene.durationSec} min={1} max={120} step={0.5} onChange={(durationSec) => edit({ durationSec })} /></Field>
              <Field label={tr('Ширина, px', 'Width, px')}><NumberInput value={scene.width} min={320} max={3840} onChange={(width) => edit({ width })} /></Field>
              <Field label={tr('Высота, px', 'Height, px')}><NumberInput value={scene.height} min={180} max={2160} onChange={(height) => edit({ height })} /></Field>
              <Field label={tr('Громкость', 'Volume')} wide><input type="range" min={0} max={1} step={0.05} value={scene.volume} onChange={(event) => edit({ volume: Number(event.target.value) })} /></Field>
              <Field label={tr('Пользовательские параметры · JSON', 'Custom parameters · JSON')} hint={parameterError || 'scene.params'} wide><textarea className="input studio-json" data-studio-params value={params} onChange={(event) => setParams(event.target.value)} spellCheck={false} rows={7} /></Field>
              <Field label={tr('Изображение / видео', 'Image / video')} hint="scene.params.image" wide><MediaPicker kind="visual" value={typeof parsedParams.image === 'string' ? parsedParams.image : ''} onChange={(image) => parameterError ? setNotice(parameterError) : setParams(JSON.stringify({ ...parsedParams, image: image ?? '' }, null, 2))} /></Field>
              <Field label={tr('Звук', 'Sound')} hint="scene.params.sound · scene.mediaBaseUrl" wide><MediaPicker kind="audio" value={typeof parsedParams.sound === 'string' ? parsedParams.sound : ''} onChange={(sound) => parameterError ? setNotice(parameterError) : setParams(JSON.stringify({ ...parsedParams, sound: sound ?? '' }, null, 2))} /></Field>
              <Field label={tr('Инструкции для ИИ', 'Scene AI instructions')} hint={tr('Стиль, бренд, палитра, язык, ограничения движения.', 'Style, brand, palette, language and motion constraints.')} wide><textarea className="input" rows={4} value={scene.instructions} onChange={(event) => edit({ instructions: event.target.value })} /></Field>
            </div></Card>}
            {tab === 'bindings' && <div className="stack">
              <Card title={tr('Событие → сцена', 'Event → scene')}><p className="muted small">{tr('Без назначения используется обычный алерт. Выбор доступен после публикации.', 'Unassigned events use standard alerts. Publish a scene before assigning it.')}</p><div className="form">{SCENE_EVENT_TYPES.map((type) => <Field key={type} label={eventNames[language][type]}><select className="input select" data-studio-binding={type} value={studio.bindings[type] ?? ''} onChange={(event) => updateStudio((value) => ({ ...value, bindings: { ...value.bindings, [type]: event.target.value } }))}>{sceneOptions.filter((item) => !item.value || published.some((candidate) => candidate.id === item.value && (candidate.eventType === 'any' || candidate.eventType === type))).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>)}</div></Card>
              <Card title={tr('Уровни донатов', 'Donation levels')} actions={<Button data-studio-action="add-level" size="sm" onClick={() => updateStudio((value) => ({ ...value, donationLevels: [...value.donationLevels, { id: makeId(), name: tr('Крупный донат', 'Large donation'), minAmount: 1000, sceneId: published[0]?.id ?? '' }] }))}>{tr('Добавить уровень', 'Add level')}</Button>}>
                <p className="muted small">{tr('Выбирается наибольший подходящий порог с опубликованной сценой.', 'The highest applicable threshold with a published scene wins.')} {currency}</p>
                {!sameCurrency && <p className="muted small" data-studio-currency-note>{tr('Для другой валюты нужна подтверждённая конвертация сервиса донатов. В тесте используется основная привязка события.', 'Another currency requires a confirmed provider conversion. This sample uses the base event binding.')}</p>}
                {studio.donationLevels.map((level) => <div key={level.id} className="studio-level" data-studio-level={level.id}>
                  <Field label={tr('Название', 'Name')}><TextInput value={level.name} onChange={(name) => updateStudio((value) => ({ ...value, donationLevels: value.donationLevels.map((item) => item.id === level.id ? { ...item, name } : item) }))} /></Field>
                  <Field label={tr('От суммы', 'Minimum amount')}><NumberInput min={0} value={level.minAmount} onChange={(minAmount) => updateStudio((value) => ({ ...value, donationLevels: value.donationLevels.map((item) => item.id === level.id ? { ...item, minAmount } : item) }))} /></Field>
                  <Field label={tr('Сцена', 'Scene')}><Select value={level.sceneId} options={donationOptions} onChange={(sceneId) => updateStudio((value) => ({ ...value, donationLevels: value.donationLevels.map((item) => item.id === level.id ? { ...item, sceneId } : item) }))} /></Field>
                  <Button variant="danger" size="sm" onClick={() => updateStudio((value) => ({ ...value, donationLevels: value.donationLevels.filter((item) => item.id !== level.id) }))}>{tr('Удалить', 'Remove')}</Button>
                </div>)}
                <div className="studio-route-result" data-studio-donation-match>{sample.amount} {sample.currency} → <strong>{donationScene?.name ?? tr('Стандартный алерт', 'Standard alert')}</strong>{applicable && <span> ≥ {applicable.minAmount}</span>}<Button size="sm" disabled={!donationScene} onClick={() => { setSample({ ...sample, type: 'donation' }); if (donationScene) { setRuntime('loading'); setRuntimeError(''); setPreview({ scene: donationScene, event: { ...sample, type: 'donation' }, id: makeId(), muted }); } }}>{tr('Проверить выбор', 'Preview matched scene')}</Button></div>
              </Card>
              <Card title={tr('Серии подарков', 'Gift batches')}><Field label={tr('Окно объединения, сек', 'Merge window, seconds')} hint={tr('Подарки одного отправителя объединяются в один запуск со счётчиком count.', 'Gifts from the same sender are merged into one playback with count.')}><NumberInput value={studio.giftMergeWindowSec} min={0} max={5} step={0.1} onChange={(giftMergeWindowSec) => updateStudio((value) => ({ ...value, giftMergeWindowSec }))} /></Field></Card>
            </div>}
            {tab === 'ai' && <div className="stack">
              <Card title={tr('Генерация сцены с ИИ', 'AI scene generation')}>
                {ai ? <div className="form">
                  <Field label={tr('Провайдер', 'Provider')}><Select value={ai.config.provider} options={[{ value: 'responses', label: 'OpenAI Responses' }, { value: 'compatible', label: 'OpenAI-compatible' }, { value: 'anthropic', label: 'Anthropic' }]} onChange={(provider) => setAi({ ...ai, config: { ...ai.config, provider, baseUrl: provider === 'anthropic' && ai.config.baseUrl === 'https://api.openai.com/v1' ? 'https://api.anthropic.com/v1' : provider === 'responses' && ai.config.baseUrl === 'https://api.anthropic.com/v1' ? 'https://api.openai.com/v1' : ai.config.baseUrl, temperature: provider === 'anthropic' && ai.config.temperature !== null ? Math.min(ai.config.temperature, 1) : ai.config.temperature } })} /></Field>
                  <Field label={tr('Модель', 'Model')}><input className="input" data-studio-ai-model value={ai.config.model} onChange={(event) => setAi({ ...ai, config: { ...ai.config, model: event.target.value } })} /></Field>
                  <Field label="Base URL" wide><TextInput value={ai.config.baseUrl} onChange={(baseUrl) => setAi({ ...ai, config: { ...ai.config, baseUrl } })} /></Field>
                  <Field label={tr('API-ключ', 'API key')} hint={ai.hasApiKey ? tr('Ключ сохранён в основном процессе.', 'A key is stored in the main process.') : tr('Ключ ещё не сохранён.', 'No key stored.')} wide><input className="input" data-studio-api-key type="password" autoComplete="new-password" value={apiKey} placeholder={tr('Новый ключ (необязательно)', 'New key (optional)')} onChange={(event) => { setApiKey(event.target.value); setKeyAction('replace'); }} /></Field>
                  <Field label={tr('Сохранённый ключ', 'Stored key')}><Select value={keyAction} options={[{ value: 'preserve', label: tr('Оставить', 'Keep') }, { value: 'replace', label: tr('Заменить', 'Replace') }, { value: 'remove', label: tr('Удалить', 'Remove') }]} onChange={setKeyAction} /></Field>
                  <Field label="Temperature"><Toggle checked={ai.config.temperature !== null} label={tr('Указать', 'Specify')} onChange={(enabled) => setAi({ ...ai, config: { ...ai.config, temperature: enabled ? 0.7 : null } })} />{ai.config.temperature !== null && <NumberInput value={ai.config.temperature} min={0} max={ai.config.provider === 'anthropic' ? 1 : 2} step={0.1} onChange={(temperature) => setAi({ ...ai, config: { ...ai.config, temperature } })} />}</Field>
                  <Field label={tr('Максимум токенов', 'Max tokens')}><NumberInput value={ai.config.maxTokens} min={256} max={32768} onChange={(maxTokens) => setAi({ ...ai, config: { ...ai.config, maxTokens } })} /></Field>
                  <Field label={tr('Таймаут, сек', 'Timeout, seconds')}><NumberInput value={ai.config.timeoutSec} min={5} max={180} onChange={(timeoutSec) => setAi({ ...ai, config: { ...ai.config, timeoutSec } })} /></Field>
                  <Field label={tr('Системные инструкции', 'System instructions')} hint={tr('Задайте бренд, палитру и язык всех новых сцен.', 'Define brand, palette and language for new scenes.')} wide><textarea className="input" rows={5} value={ai.config.systemPrompt} onChange={(event) => setAi({ ...ai, config: { ...ai.config, systemPrompt: event.target.value } })} /></Field>
                  <Button data-studio-action="save-ai" onClick={async () => { const status = await call('scene:ai:configure', ai.config as SceneAiConfig, keyAction === 'preserve' ? undefined : keyAction === 'remove' ? '' : apiKey); if (status) { setAi(status); setApiKey(''); setKeyAction('preserve'); setNotice(tr('Настройки ИИ сохранены.', 'AI settings saved.')); } }}>{tr('Сохранить настройки ИИ', 'Save AI settings')}</Button>
                  <Field label={tr('Задание для сцены', 'Scene prompt')} wide><textarea className="input" data-studio-ai-prompt rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={tr('Например: неоновая сцена рейда с именем и числом зрителей…', 'For example: a neon raid scene with username and viewer count…')} /></Field>
                  <div className="studio-actions"><Button data-studio-action="generate" variant="primary" disabled={!scene || !!parameterError || !prompt.trim() || generating} onClick={() => void generate()}>{generating ? tr('Генерация…', 'Generating…') : tr('Создать черновик с ИИ', 'Generate AI draft')}</Button>{generating && <Button onClick={() => { generation.current++; setGenerating(false); setNotice(tr('Ожидание отменено. Поздний ответ не изменит сцену.', 'Stopped waiting. A late response will not change your scene.')); }}>{tr('Отменить', 'Cancel')}</Button>}</div>
                  {aiCandidate && <div className="studio-candidate"><strong>{tr('Новая версия в превью', 'New version in preview')}</strong><Button data-studio-action="apply-ai" onClick={() => { if ((signature(scene) !== aiCandidateBaseline.current.scene || params !== aiCandidateBaseline.current.params) && !window.confirm(tr('Черновик изменился после генерации. Заменить его результатом ИИ?', 'The draft changed after generation. Replace it with the AI result?'))) return; setScene({ ...aiCandidate, id: scene!.id, published: scene!.published, draftOf: scene!.draftOf }); setParams(JSON.stringify(aiCandidate.parameters, null, 2)); setAiCandidate(null); }}>{tr('Применить к черновику', 'Apply to draft')}</Button><Button onClick={() => { setAiCandidate(null); restart(); }}>{tr('Отклонить', 'Discard')}</Button></div>}
                </div> : <p role="status">{tr('Загрузка конфигурации ИИ…', 'Loading AI configuration…')}</p>}
              </Card>
              <Card className="studio-mcp-card" title={tr('Локальный MCP-сервер', 'Local MCP server')}>
                {mcp && <div className="stack"><p className="muted small">{tr('Подключайте локальный ИИ-клиент к студии. Токен даёт доступ к чтению и изменению сцен.', 'Connect your local AI client to the studio. The token grants scene read and write access.')}</p><Toggle checked={mcp.enabled} label={tr('Включить MCP', 'Enable MCP')} onChange={async (enabled) => { const result = await call('scene:mcp:configure', enabled, mcpPort); if (result) setMcp(result); }} /><Field label={tr('Локальный порт', 'Local port')}><NumberInput value={mcpPort} min={1024} max={65535} onChange={setMcpPort} /></Field><Button onClick={async () => { const result = await call('scene:mcp:configure', mcp.enabled, mcpPort); if (result) setMcp(result); }}>{tr('Применить порт', 'Apply port')}</Button><div data-studio-mcp-status className="studio-route-result">{mcp.error || (mcp.running ? tr('Работает', 'Running') : tr('Остановлен', 'Stopped'))}</div><CopyField value={JSON.stringify({ mcpServers: { streamhelper: { url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }, null, 2)} /><Button onClick={async () => { const result = await call('scene:mcp:rotate'); if (result) setMcp(result); }}>{tr('Обновить токен', 'Rotate token')}</Button><p className="muted small">{tr('Инструменты: контекст студии, список и чтение сцен, сохранение черновика, превью. Публикация — в редакторе.', 'Tools: studio context, list/read scenes, save draft, preview. Publish from the editor.')}</p></div>}
              </Card>
            </div>}
          </div>
          <aside className="studio-preview-panel">
            <div className="studio-preview-head"><strong>{tr('Живое превью', 'Live preview')}</strong><Button data-studio-action="restart" size="sm" disabled={!scene || !!parameterError} onClick={() => restart()}>{tr('Перезапустить', 'Restart')}</Button></div>
            <div ref={box} className="studio-stage checker" style={{ height: preview ? Math.max(180, preview.scene.height * scale) : 280 }}>
              {preview ? <iframe key={preview.id} ref={frame} title="Scene preview" data-studio-preview sandbox="allow-scripts" src={`${overlayUrl}/overlay/assets/scene-frame.html`} style={{ width: preview.scene.width, height: preview.scene.height, transform: `scale(${scale})`, left: (boxWidth - preview.scene.width * scale) / 2 }} /> : <div className="studio-stage-placeholder"><span>▶</span>{tr('Запустите сцену для проверки', 'Run the scene to preview')}</div>}
            </div>
            <div className="studio-preview-status" data-studio-runtime={runtime}>{runtime === 'ready' ? tr('Сцена запущена', 'Scene ready') : runtime === 'finished' ? tr('Завершено', 'Finished') : runtime === 'loading' ? tr('Загрузка…', 'Loading…') : tr('Превью изолировано от эфира', 'Preview is separate from live playback')}</div>
            {runtimeError && <div className="studio-error" role="alert" data-studio-runtime-error>{runtimeError}</div>}
            <Toggle checked={!muted} label={tr('Звук в превью', 'Preview audio')} onChange={(enabled) => { setMuted(!enabled); if (preview) { setRuntime('loading'); setPreview({ ...preview, muted: !enabled, id: makeId() }); } }} />
            <Card title={tr('Тестовое событие', 'Sample event')}><div className="form studio-sample">
              <Field label={tr('Событие', 'Event')} wide><select className="input select" data-studio-sample="type" value={sample.type} onChange={(event) => setSample({ ...sample, type: event.target.value as AlertType })}>{SCENE_EVENT_TYPES.map((type) => <option key={type} value={type}>{eventNames[language][type]}</option>)}</select></Field>
              <Field label={tr('Имя', 'Username')} wide><input className="input" data-studio-sample="user" value={sample.user} onChange={(event) => setSample({ ...sample, user: event.target.value })} /></Field>
              <Field label={tr('Сумма / битсы', 'Amount / bits')}><NumberInput value={sample.amount} min={0} onChange={(amount) => setSample({ ...sample, amount })} /></Field>
              <Field label={tr('Валюта', 'Currency')}><TextInput value={sample.currency} onChange={(currency) => setSample({ ...sample, currency })} /></Field>
              <Field label={tr('Подарки', 'Gift count')}><NumberInput value={sample.count} min={1} onChange={(count) => setSample({ ...sample, count })} /></Field>
              <Field label={tr('Зрители рейда', 'Raid viewers')}><NumberInput value={sample.viewers} min={0} onChange={(viewers) => setSample({ ...sample, viewers })} /></Field>
              <Field label={tr('Месяцы', 'Months')}><NumberInput value={sample.months} min={1} onChange={(months) => setSample({ ...sample, months })} /></Field>
              <Field label={tr('Уровень подписки', 'Subscription tier')}><TextInput value={sample.tier} onChange={(tier) => setSample({ ...sample, tier })} /></Field>
              <Field label={tr('Сообщение', 'Message')} wide><textarea className="input" data-studio-sample="message" rows={3} value={sample.message} onChange={(event) => setSample({ ...sample, message: event.target.value })} /></Field>
            </div><p className="muted small">{tr('Измените данные и нажмите «Перезапустить». Событие не отправляется в OBS.', 'Change the data, then Restart. This event is not sent to OBS.')}</p></Card>
          </aside>
        </div>
      </section>
    </div>
  </div>;
}
