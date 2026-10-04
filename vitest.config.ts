import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Keep all test fixtures and their cleanup inside this checkout.
const testTemp = resolve(__dirname, 'node_modules/.cache/test-tmp');
mkdirSync(testTemp, { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = testTemp;

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
