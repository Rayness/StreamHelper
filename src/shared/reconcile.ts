/** Preserve unchanged branches after an IPC clone so selectors only rerender changed sections. */
export function reconcile<T>(previous: T, incoming: T): T {
  if (Object.is(previous, incoming)) return previous;
  if (!previous || !incoming || typeof previous !== 'object' || typeof incoming !== 'object' || Array.isArray(previous) !== Array.isArray(incoming)) return incoming;
  const old = previous as Record<string, unknown>;
  const next = incoming as Record<string, unknown>;
  const keys = Object.keys(next);
  let same = keys.length === Object.keys(old).length;
  const result: any = Array.isArray(incoming) ? [] : {};
  for (const key of keys) {
    result[key] = reconcile(old[key], next[key]);
    if (!Object.is(result[key], old[key])) same = false;
  }
  return same ? previous : result;
}
