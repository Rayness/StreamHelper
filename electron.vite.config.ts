import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const shared = { '@shared': resolve(__dirname, 'src/shared') };

/** Dev only: the React refresh preamble is an inline script and HMR needs a websocket. */
function devCsp(): Plugin {
  return {
    name: 'dev-csp',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*"),
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
  },
  renderer: {
    build: { minify: true, cssMinify: true, target: 'es2022' },
    resolve: { alias: { ...shared, '@renderer': resolve(__dirname, 'src/renderer/src') } },
    // Explicit IPv4: "localhost" may resolve to ::1 while Electron connects over IPv4.
    server: { host: '127.0.0.1', port: 5173 },
    plugins: [react(), devCsp()],
  },
});
