/** Parse "!cmd a b c" into name + args. Returns null if the text isn't a command. */
export function parseCommand(text: string, prefix: string): { name: string; args: string[] } | null {
  const t = text.trim();
  if (!prefix || !t.startsWith(prefix)) return null;
  const [name, ...args] = t.slice(prefix.length).split(/\s+/).filter(Boolean);
  if (!name) return null;
  return { name: name.toLowerCase(), args };
}

/** {random:1-100} or {random:heads|tails}. Rand injectable for tests. */
export function randomValue(arg: string | undefined, rand: () => number = Math.random): string | undefined {
  if (!arg) return String(Math.floor(rand() * 100) + 1);
  const range = /^\s*(-?\d+)\s*-\s*(-?\d+)\s*$/.exec(arg);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
    return String(a + Math.floor(rand() * (b - a + 1)));
  }
  const options = arg.split('|').map((s) => s.trim()).filter(Boolean);
  return options.length ? options[Math.floor(rand() * options.length)] : undefined;
}

export function normalizeLogin(s: string | undefined): string {
  return (s ?? '').replace(/^@/, '').trim();
}
