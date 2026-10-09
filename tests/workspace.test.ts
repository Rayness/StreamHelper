import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import { isWorkspaceModule, monitorCards, normalizeMonitorLayout, reorderCards, workspaceCards, normalizeWorkspaceCards, resolveModuleAccess, workspaceTarget, WORKSPACE_CARDS } from '@shared/workspace';

describe('module-owned workspace', () => {
  it('moves services out of the workspace while retaining OBS controls', () => {
    expect(workspaceCards(['twitch','obs','donationalerts','chat','subforstream'])).toEqual(['obs','chat']);
  });
  it('keeps a monitor order independent from installed module order and restores hidden cards', () => {
    const layout={order:['events','chat','alerts'],hidden:['chat'],sizes:{chat:{width:2,height:'tall'}}};
    expect(monitorCards(['chat','alerts','events','goal'],layout)).toEqual(['events','alerts','goal']);
    expect(monitorCards(['chat','alerts'],{...layout,hidden:[]})).toEqual(['chat','alerts']);
    expect(normalizeMonitorLayout({order:['chat','fake'],hidden:['twitch'],sizes:{chat:{width:99,height:'invalid'}}})).toEqual({order:['chat'],hidden:[],sizes:{chat:{width:1,height:'compact'}},positions:{}});
    expect(reorderCards(['chat','alerts','events'],'chat','events')).toEqual(['alerts','events','chat']);
    expect(reorderCards(['chat','alerts','events'],'events','chat')).toEqual(['events','chat','alerts']);
  });
  it('starts empty and never installs modules by visiting a route', () => {
    const settings = defaultSettings('ru');
    expect(settings.workspace.cards).toEqual([]);
    for (const id of WORKSPACE_CARDS) expect(resolveModuleAccess(id,settings.workspace.cards)).toEqual({catalog:id});
    expect(settings.workspace.cards).toEqual([]);
  });
  it('allows only installed module editors and immediately revokes removed ones', () => {
    for (const id of WORKSPACE_CARDS) {
      expect(resolveModuleAccess(id,[id])).toEqual({module:id});
      expect(resolveModuleAccess(id,[])).toEqual({catalog:id});
    }
    expect(resolveModuleAccess('settings',['alerts'])).toEqual({});
    expect(resolveModuleAccess('__proto__',['__proto__'])).toEqual({});
  });
  it('routes old shortcuts to the specific module boundary', () => {
    expect(workspaceTarget('alerts')).toBe('alerts');
    expect(workspaceTarget('overlays','song')).toBe('song');
    expect(workspaceTarget('interactive','quiz')).toBe('quiz');
    expect(workspaceTarget('connections')).toBe('twitch');
    expect(workspaceTarget('connections','donationalerts')).toBe('donationalerts');
    expect(workspaceTarget('settings')).toBeUndefined();
    expect(workspaceTarget('unknown','alerts')).toBeUndefined();
    expect(resolveModuleAccess(workspaceTarget('interactive','quiz'),['poll'])).toEqual({catalog:'quiz'});
  });
  it('migrates explicit aggregate cards without losing selections or creating defaults', () => {
    expect(normalizeWorkspaceCards(undefined)).toEqual([]);
    expect(normalizeWorkspaceCards(['activities','counters','counter','chat','chat','unknown'])).toEqual(['wheel','poll','giveaway','queue','guess','quiz','boss','counter','chat']);
  });
  it('module registry contains only unique supported IDs', () => {
    expect(WORKSPACE_CARDS.length).toBe(47);
    expect(WORKSPACE_CARDS).toContain('donations');
    // Custom overlays have their own Designer tab.
    expect(WORKSPACE_CARDS).not.toContain('custom');
    expect(new Set(WORKSPACE_CARDS).size).toBe(WORKSPACE_CARDS.length);
    expect(WORKSPACE_CARDS.every(isWorkspaceModule)).toBe(true);
  });
});
