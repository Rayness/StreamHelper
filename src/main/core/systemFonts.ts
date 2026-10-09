import { execFile } from 'node:child_process';

let cached: Promise<string[]> | null = null;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** "Segoe UI Semibold (TrueType)" -> "Segoe UI Semibold"; "A & B (TrueType)" -> ["A", "B"]. */
export function registryFontNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s{2,}(.+?)\s{2,}REG_\w+\s/.exec(line);
    if (!match) continue;
    const label = match[1].replace(/\s*\((TrueType|OpenType|All res)\)\s*$/i, '').trim();
    for (const part of label.split(/\s+&\s+/)) if (part && !/^@/.test(part)) names.push(part.trim());
  }
  return names;
}

export function uniqueSorted(names: string[]): string[] {
  const seen = new Map<string, string>();
  for (const name of names) {
    const clean = name.trim();
    if (clean && !clean.startsWith('@') && !seen.has(clean.toLowerCase())) seen.set(clean.toLowerCase(), clean);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

async function load(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  try {
    // Font families as GDI+ sees them (system-wide and per-user installs): what OBS's browser can use.
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }']);
    const names = uniqueSorted(out.split(/\r?\n/));
    if (names.length) return names;
  } catch (err) {
    console.warn('[fonts] powershell', String((err as Error)?.message ?? err));
  }
  const keys = ['HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'];
  const outputs = await Promise.all(keys.map((key) => run('reg.exe', ['query', key]).catch(() => '')));
  return uniqueSorted(outputs.flatMap(registryFontNames));
}

/** Installed font families, looked up once per run. */
export function systemFonts(): Promise<string[]> {
  cached ??= load().catch(() => []);
  return cached;
}
