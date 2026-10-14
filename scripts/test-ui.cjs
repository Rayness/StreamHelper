const { resolve, join } = require('node:path');
const { mkdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const root = resolve(__dirname, '..');
const output = join(root, 'dist/qa');
mkdirSync(output, { recursive: true });
const tmp = join(root, 'node_modules/.cache/ui-tmp'); mkdirSync(tmp, { recursive: true });
buildSync({ entryPoints: [join(__dirname, 'ui-fixture.ts')], outfile: join(output, 'fixture.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['ws'], alias: { '@shared': join(root, 'src/shared') } });
buildSync({ entryPoints: [join(__dirname, 'remote-ui-fixture.ts')], outfile: join(output, 'remote-fixture.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['ws'], alias: { '@shared': join(root, 'src/shared') } });
const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp }; delete env.ELECTRON_RUN_AS_NODE;
// The app window first, then the same UI in a moderator's browser over remote access.
for (const main of process.argv.includes('--remote') ? ['remote-ui-test-main.cjs'] : ['ui-test-main.cjs', 'remote-ui-test-main.cjs']) {
  const result = spawnSync(require('electron'), [join(__dirname, main)], { cwd: root, env, stdio: 'inherit', timeout: 120000 });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
