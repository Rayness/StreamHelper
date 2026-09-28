/** Structural equality for JSON-like settings values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasIds = (v: unknown): v is { id: string }[] => Array.isArray(v) && v.every((x) => isPlain(x) && typeof x.id === 'string');

/**
 * Three-way merge of a settings section. `base` is what the editor started from, `mine` is the
 * editor's result and `theirs` is what the app holds now (goal progress, counters, subathon time
 * may have moved meanwhile). Whatever the editor did not touch keeps the app's newer value;
 * on a real conflict the editor wins.
 */
export function merge3<T>(base: unknown, mine: T, theirs: unknown): T {
  if (deepEqual(mine, base)) return theirs as T;
  if (deepEqual(theirs, base) || theirs === undefined) return mine;
  if (isPlain(mine) && isPlain(theirs)) {
    const b = isPlain(base) ? base : {};
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(mine)) {
      if (key in theirs || !(key in b)) out[key] = merge3(b[key], mine[key], theirs[key]);
      // Removed by the app meanwhile: stays removed unless it was edited here.
      else if (!deepEqual(mine[key], b[key])) out[key] = mine[key];
    }
    // Added by the app meanwhile (a new counter from chat): keep it.
    for (const key of Object.keys(theirs)) if (!(key in mine) && !(key in b)) out[key] = theirs[key];
    return out as T;
  }
  if (hasIds(mine) && hasIds(theirs)) {
    const b = new Map((hasIds(base) ? base : []).map((x) => [x.id, x]));
    const t = new Map(theirs.map((x) => [x.id, x]));
    const out: { id: string }[] = [];
    for (const item of mine) {
      // Removed by the app meanwhile (and untouched here): stay removed.
      if (!t.has(item.id) && b.has(item.id) && deepEqual(item, b.get(item.id))) continue;
      out.push(t.has(item.id) ? merge3(b.get(item.id), item, t.get(item.id)) : item);
    }
    const mineIds = new Set(mine.map((x) => x.id));
    for (const item of theirs) if (!mineIds.has(item.id) && !b.has(item.id)) out.push(item);
    return out as T;
  }
  return mine;
}
