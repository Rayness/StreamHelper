import { useState } from 'react';
import type { WorkspaceCard } from '@shared/types';
import { STARTER_PRESETS, moduleName, type StarterPreset } from '../workspaceModules';
import { useT, type TKey } from '../i18n';
import { call, navigate, openCatalog, saveSettings, toast, useApp } from '../store';
import { Icon } from './icons';
import { Button, StatusText } from './ui';

type Step = 1 | 2 | 3;

export function OnboardingWizard() {
  const t = useT();
  const state = useApp((d) => d.state!);
  const workspace = useApp((d) => d.settings!.workspace);
  const remote = useApp((d) => !!d.remote);
  const twitchConnected = state.twitch.status === 'connected';
  const obsConnected = state.obs.status === 'connected';
  const [step, setStep] = useState<Step>(() => (remote ? 3 : twitchConnected && obsConnected ? 3 : twitchConnected ? 2 : 1));
  const [selectedPreset, setSelectedPreset] = useState<StarterPreset['id']>('starter');

  const applyPreset = (cards: readonly WorkspaceCard[]) => {
    saveSettings('workspace', { ...workspace, cards: [...cards] });
    toast('success', 'onboarding.presetApplied');
    navigate('dashboard');
  };

  const steps: { id: Step; label: TKey; done: boolean }[] = remote
    ? [{ id: 3, label: 'onboarding.step3', done: false }]
    : [
        { id: 1, label: 'onboarding.step1', done: twitchConnected },
        { id: 2, label: 'onboarding.step2', done: obsConnected },
        { id: 3, label: 'onboarding.step3', done: false },
      ];

  const activePreset = STARTER_PRESETS.find((p) => p.id === selectedPreset) ?? STARTER_PRESETS[0];

  return (
    <div className="workspace-welcome onboarding" data-testid="onboarding-wizard">
      <div className="onboarding-shell">
        <header className="onboarding-top">
          <div className="onboarding-head">
            <span className="onboarding-badge">
              <Icon name="rocket" size={14} />
              {t('onboarding.badge')}
            </span>
            <h2>{t('workspace.empty')}</h2>
            <p className="muted">{t('workspace.emptyHint')}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={openCatalog}>
            {t('onboarding.skip')}
          </Button>
        </header>

        {steps.length > 1 && (
          <nav className="onboarding-steps" aria-label={t('onboarding.badge')}>
            {steps.map((s, idx) => (
              <button
                key={s.id}
                type="button"
                className={`onboarding-step ${step === s.id ? 'active' : ''} ${s.done ? 'done' : ''}`}
                aria-current={step === s.id ? 'step' : undefined}
                onClick={() => setStep(s.id)}
              >
                <span className="onboarding-step-num">
                  {s.done ? <Icon name="check" size={13} /> : idx + 1}
                </span>
                <span>{t(s.label)}</span>
              </button>
            ))}
          </nav>
        )}

        {step === 1 && !remote && (
          <section className="onboarding-card">
            <h3>{t('onboarding.step1Title')}</h3>
            <p className="muted small">{t('onboarding.step1Desc')}</p>
            <div className="onboarding-service">
              <div className="onboarding-service-info">
                <span className="onboarding-service-icon twitch">
                  <Icon name="broadcast" size={20} />
                </span>
                <div>
                  <strong>Twitch</strong>
                  <div className="muted small">
                    {state.twitch.account
                      ? t('onboarding.twitchReady', { name: state.twitch.account.displayName })
                      : t('conn.twitchHint')}
                  </div>
                </div>
              </div>
              <div className="onboarding-service-actions">
                <StatusText status={state.twitch.status} error={state.twitch.error} />
                {!twitchConnected && (
                  <Button variant="primary" size="sm" icon="plug" onClick={() => navigate('connections', 'twitch')}>
                    {t('conn.login')}
                  </Button>
                )}
              </div>
            </div>

            <div className="onboarding-secondary-row">
              <Button size="sm" variant="ghost" icon="coin" onClick={() => navigate('connections', 'donationalerts')}>
                {t('onboarding.moreDonations')}
              </Button>
            </div>

            <footer className="onboarding-footer">
              <Button variant="ghost" onClick={() => setStep(2)}>
                {t('onboarding.later')}
              </Button>
              <Button variant="primary" onClick={() => setStep(2)}>
                {t('onboarding.next')}
              </Button>
            </footer>
          </section>
        )}

        {step === 2 && !remote && (
          <section className="onboarding-card">
            <h3>{t('onboarding.step2Title')}</h3>
            <p className="muted small">{t('onboarding.step2Desc')}</p>
            <div className="onboarding-service">
              <div className="onboarding-service-info">
                <span className="onboarding-service-icon obs">
                  <Icon name="video" size={20} />
                </span>
                <div>
                  <strong>OBS Studio</strong>
                  <div className="muted small">
                    {obsConnected ? t('onboarding.obsConnected') : t('onboarding.obsHow')}
                  </div>
                </div>
              </div>
              <div className="onboarding-service-actions">
                <StatusText status={state.obs.status} error={state.obs.error} />
                {!obsConnected && (
                  <Button variant="primary" size="sm" icon="plug" onClick={() => void call('obs:connect')}>
                    {t('onboarding.obsConnectNow')}
                  </Button>
                )}
              </div>
            </div>

            <div className="onboarding-secondary-row">
              <Button size="sm" variant="ghost" icon="settings" onClick={() => navigate('connections', 'obs')}>
                {t('onboarding.obsSettings')}
              </Button>
            </div>

            <footer className="onboarding-footer">
              <Button variant="ghost" onClick={() => setStep(1)}>
                {t('onboarding.back')}
              </Button>
              <div className="row-gap">
                {!obsConnected && (
                  <Button variant="ghost" onClick={() => setStep(3)}>
                    {t('onboarding.later')}
                  </Button>
                )}
                <Button variant="primary" onClick={() => setStep(3)}>
                  {t('onboarding.next')}
                </Button>
              </div>
            </footer>
          </section>
        )}

        {step === 3 && (
          <section className="onboarding-card">
            <h3>{t('onboarding.step3Title')}</h3>
            <p className="muted small">{t('onboarding.step3Desc')}</p>

            <div className="preset-grid">
              {STARTER_PRESETS.map((preset) => {
                const active = selectedPreset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    data-onboarding-preset={preset.id}
                    className={`preset-card ${active ? 'active' : ''}`}
                    aria-pressed={active}
                    onClick={() => setSelectedPreset(preset.id)}
                  >
                    <div className="preset-card-head">
                      <span className="preset-icon">
                        <Icon name={preset.icon} size={19} />
                      </span>
                      <strong>{t(`preset.${preset.id}.title` as TKey)}</strong>
                      {preset.recommended && <span className="preset-badge">{t('onboarding.recommended')}</span>}
                    </div>
                    <p className="muted small">{t(`preset.${preset.id}.desc` as TKey)}</p>
                    <div className="preset-tags">
                      {preset.cards.slice(0, 5).map((id) => (
                        <span key={id} className="preset-tag">
                          {moduleName(id, t)}
                        </span>
                      ))}
                      {preset.cards.length > 5 && <span className="preset-tag">+{preset.cards.length - 5}</span>}
                    </div>
                  </button>
                );
              })}

              <button
                type="button"
                data-onboarding-preset="custom"
                className="preset-card preset-card-custom"
                onClick={openCatalog}
              >
                <div className="preset-card-head">
                  <span className="preset-icon">
                    <Icon name="plus" size={19} />
                  </span>
                  <strong>{t('onboarding.customStart')}</strong>
                </div>
                <p className="muted small">{t('onboarding.customStartDesc')}</p>
              </button>
            </div>

            <footer className="onboarding-footer">
              {!remote ? (
                <Button variant="ghost" onClick={() => setStep(2)}>
                  {t('onboarding.back')}
                </Button>
              ) : (
                <span />
              )}
              <Button variant="primary" icon="rocket" data-onboarding-apply onClick={() => applyPreset(activePreset.cards)}>
                {t('onboarding.applyPreset')}
              </Button>
            </footer>
          </section>
        )}
      </div>
    </div>
  );
}
