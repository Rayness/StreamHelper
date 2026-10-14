import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TtsSystemVoice } from '@shared/types';

/**
 * Windows speech in a short-lived PowerShell: OneCore voices through WinRT (the ones from
 * Settings → Speech, including male Russian voices), the older desktop SAPI voices as a fallback.
 * Audio is written to a WAV file that the TTS overlay plays in OBS.
 */
const WINRT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait() | Out-Null; $t.Result }
`;

const VOICES_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$list = @()
try {
  [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime] | Out-Null
  foreach ($v in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) { $list += [pscustomobject]@{ name = $v.DisplayName; lang = $v.Language; gender = $v.Gender.ToString().ToLower(); source = 'onecore' } }
} catch {}
try {
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  foreach ($v in $s.GetInstalledVoices()) { if ($v.Enabled) { $i = $v.VoiceInfo; $list += [pscustomobject]@{ name = $i.Name; lang = $i.Culture.Name; gender = $i.Gender.ToString().ToLower(); source = 'sapi' } } }
  $s.Dispose()
} catch {}
ConvertTo-Json -InputObject @($list) -Compress
`;

const SPEAK_SCRIPT = `
param([string]$Job)
$ErrorActionPreference = 'Stop'
$j = [IO.File]::ReadAllText($Job, [Text.Encoding]::UTF8) | ConvertFrom-Json
if ($j.source -ne 'sapi') {
  try {
${WINRT}
    $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
    $v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $j.voice } | Select-Object -First 1
    if ($v) { $synth.Voice = $v }
    try { $synth.Options.SpeakingRate = [double]$j.rate; $synth.Options.AudioPitch = [double]$j.pitch } catch {}
    $stream = Await ($synth.SynthesizeTextToStreamAsync([string]$j.text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
    $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
    $n = Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32])
    $bytes = New-Object byte[] $n
    $reader.ReadBytes($bytes)
    [IO.File]::WriteAllBytes([string]$j.out, $bytes)
    exit 0
  } catch { if ($j.source -eq 'onecore') { throw } }
}
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($j.voice) { try { $s.SelectVoice([string]$j.voice) } catch {} }
$s.Rate = [Math]::Max(-10, [Math]::Min(10, [int][Math]::Round(([Math]::Log([double]$j.rate) / [Math]::Log(2)) * 5)))
$s.SetOutputToWaveFile([string]$j.out)
$s.Speak([string]$j.text)
$s.Dispose()
`;

export interface SpeakJob {
  text: string;
  /** Windows voice name; empty = the system default. */
  voice: string;
  source: TtsSystemVoice['source'] | '';
  rate: number;
  pitch: number;
}

const KEEP_FILES = 20;

function powershell(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split(/\r?\n/)[0] || 'PowerShell failed'));
      else resolve(stdout);
    });
  });
}

export class TtsEngine {
  private ready = false;
  private seq = 0;

  constructor(private dir: string) {}

  private prepare(): void {
    if (this.ready) return;
    mkdirSync(this.dir, { recursive: true });
    // Audio of the previous run is never played again.
    for (const f of readdirSync(this.dir)) if (f.endsWith('.wav') || f.endsWith('.json')) rmSync(join(this.dir, f), { force: true });
    writeFileSync(join(this.dir, 'speak.ps1'), `﻿${SPEAK_SCRIPT}`, 'utf8');
    writeFileSync(join(this.dir, 'voices.ps1'), `﻿${VOICES_SCRIPT}`, 'utf8');
    this.ready = true;
  }

  async voices(): Promise<TtsSystemVoice[]> {
    if (process.platform !== 'win32') return [];
    this.prepare();
    const out = await powershell(['-File', join(this.dir, 'voices.ps1')], 20_000);
    const list = JSON.parse(out.trim() || '[]') as TtsSystemVoice[];
    const seen = new Set<string>();
    return list.filter((v) => {
      if (!v?.name || seen.has(v.name)) return false;
      seen.add(v.name);
      v.gender = v.gender === 'male' ? 'male' : 'female';
      return true;
    });
  }

  /** Synthesize to a WAV file; resolves with its file name inside the TTS folder. */
  async speak(job: SpeakJob): Promise<string> {
    if (process.platform !== 'win32') throw new Error('Text to speech needs Windows');
    this.prepare();
    const name = `tts${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    const jobFile = join(this.dir, `${name}.json`);
    const out = join(this.dir, `${name}.wav`);
    writeFileSync(jobFile, JSON.stringify({ ...job, out }), 'utf8');
    try {
      await powershell(['-File', join(this.dir, 'speak.ps1'), jobFile], 30_000);
    } finally {
      rmSync(jobFile, { force: true });
    }
    this.cleanup();
    return `${name}.wav`;
  }

  /** Only the latest few files are kept; older ones have been played. */
  private cleanup(): void {
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith('.wav')).map((f) => ({ f, t: statSync(join(this.dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const { f } of files.slice(KEEP_FILES)) rmSync(join(this.dir, f), { force: true });
    } catch {
      // A file still being read by OBS is removed next time.
    }
  }

  path(file: string): string | null {
    return /^tts[a-z0-9]+\.wav$/.test(file) ? join(this.dir, file) : null;
  }
}
