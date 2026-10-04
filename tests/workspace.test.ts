import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import { isWorkspaceModule, normalizeWorkspaceCards, resolveModuleAccess, workspaceTarget, WORKSPACE_CARDS } from '@shared/workspace';

describe('module-owned workspace', () => {
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
    expect(WORKSPACE_CARDS.length).toBe(37);
    expect(new Set(WORKSPACE_CARDS).size).toBe(WORKSPACE_CARDS.length);
    expect(WORKSPACE_CARDS.every(isWorkspaceModule)).toBe(true);
  });
});
