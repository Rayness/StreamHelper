import { globalShortcut } from 'electron';
import type { ActionStep, QuickAction } from '@shared/types';
import { errorMessage, type AppContext } from '../core/context';

export interface ActionTargets {
  obsScene(scene: string): Promise<void>;
  obsToggleSource(scene: string, source: string): Promise<void>;
  obsToggleMute(input: string): Promise<void>;
  obsStream(mode: 'start' | 'stop' | 'toggle'): Promise<void>;
  obsRecord(mode: 'start' | 'stop' | 'toggle'): Promise<void>;
  chat(text: string): Promise<void>;
  alertsTogglePause(): void;
  alertsSkip(): void;
  counter(name: string, delta: number): void;
  timerToggle(timerId: string): void;
  timerAdd(timerId: string, seconds: number): void;
  goalAdd(goalId: string, amount: number): void;
  wheelSpin(wheelId: string): void;
  bannerToggle(bannerId: string): void;
  emoteBurst(): void;
  streamerbotAction(actionId: string): Promise<void>;
}

/** Runs dashboard buttons / global hotkeys. Each step is independent: one failing step doesn't stop the rest. */
export class ActionRunner {
  private registered: string[] = [];

  constructor(
    private ctx: AppContext,
    private targets: ActionTargets,
  ) {
    ctx.bus.on('settings:changed', (key) => {
      if (key === 'actions') this.registerHotkeys();
    });
    // Channel-points rewards can run an action: "spin the wheel", "switch scene"...
    ctx.bus.on('event', (e) => {
      if (e.type !== 'redemption') return;
      const title = e.rewardTitle.trim().toLowerCase();
      for (const a of ctx.settings.get('actions')) {
        if (a.redemptionTitle?.trim() && a.redemptionTitle.trim().toLowerCase() === title) void this.run(a.id);
      }
    });
  }

  async run(actionId: string): Promise<void> {
    const action = this.ctx.settings.get('actions').find((a) => a.id === actionId);
    if (!action) return;
    for (const step of action.steps) {
      try {
        await this.runStep(step);
      } catch (err) {
        console.warn(`[actions] "${action.label}" step ${step.type} failed`, errorMessage(err));
        this.ctx.toast('error', 'toast.actionFailed', { name: action.label, error: errorMessage(err) });
      }
    }
  }

  private async runStep(s: ActionStep): Promise<void> {
    const t = this.targets;
    switch (s.type) {
      case 'obsScene':
        return t.obsScene(s.scene);
      case 'obsToggleSource':
        return t.obsToggleSource(s.scene, s.source);
      case 'obsToggleMute':
        return t.obsToggleMute(s.input);
      case 'obsStream':
        return t.obsStream(s.mode);
      case 'obsRecord':
        return t.obsRecord(s.mode);
      case 'chat':
        return t.chat(s.text);
      case 'alertsPause':
        return t.alertsTogglePause();
      case 'alertsSkip':
        return t.alertsSkip();
      case 'counter':
        return t.counter(s.name, s.delta);
      case 'timerToggle':
        return t.timerToggle(s.timerId);
      case 'timerAdd':
        return t.timerAdd(s.timerId, s.seconds);
      case 'goalAdd':
        return t.goalAdd(s.goalId, s.amount);
      case 'wheelSpin':
        return t.wheelSpin(s.wheelId);
      case 'bannerToggle':
        return t.bannerToggle(s.bannerId);
      case 'emoteBurst':
        return t.emoteBurst();
      case 'streamerbotAction':
        return t.streamerbotAction(s.actionId);
      case 'wait':
        return new Promise((r) => setTimeout(r, Math.max(0, Math.min(60_000, s.ms))));
    }
  }

  registerHotkeys(): void {
    for (const acc of this.registered) globalShortcut.unregister(acc);
    this.registered = [];
    const failed: string[] = [];
    for (const a of this.ctx.settings.get('actions') as QuickAction[]) {
      const acc = a.hotkey.trim();
      if (!acc || this.registered.includes(acc)) continue;
      try {
        if (globalShortcut.register(acc, () => void this.run(a.id))) this.registered.push(acc);
        else failed.push(acc);
      } catch {
        failed.push(acc);
      }
    }
    if (failed.length) this.ctx.toast('error', 'toast.hotkeyFailed', { keys: failed.join(', ') });
  }

  dispose(): void {
    for (const acc of this.registered) globalShortcut.unregister(acc);
    this.registered = [];
  }
}
