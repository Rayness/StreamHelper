// Downloads OFL fonts from fontsource (npm) and writes them + fonts.css into the overlay assets.
// usage: node fetch-fonts.mjs <outDir>
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
const work = join(process.cwd(), 'work');
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

// [family, id, variable?, category, staticWeights]
const FONTS = [
  ['Inter', 'inter', true, 'sans'],
  ['Montserrat', 'montserrat', true, 'sans'],
  ['Roboto', 'roboto', true, 'sans'],
  ['Rubik', 'rubik', true, 'sans'],
  ['Nunito', 'nunito', true, 'sans'],
  ['Manrope', 'manrope', true, 'sans'],
  ['Open Sans', 'open-sans', true, 'sans'],
  ['Raleway', 'raleway', true, 'sans'],
  ['Onest', 'onest', true, 'sans'],
  ['Golos Text', 'golos-text', true, 'sans'],
  ['Exo 2', 'exo-2', true, 'sans'],
  ['Ubuntu', 'ubuntu', false, 'sans', [400, 700]],
  ['PT Sans', 'pt-sans', false, 'sans', [400, 700]],
  ['Play', 'play', false, 'sans', [400, 700]],
  ['Oswald', 'oswald', true, 'display'],
  ['Unbounded', 'unbounded', true, 'display'],
  ['Russo One', 'russo-one', false, 'display', [400]],
  ['Dela Gothic One', 'dela-gothic-one', false, 'display', [400]],
  ['Comfortaa', 'comfortaa', true, 'display'],
  ['Jura', 'jura', true, 'display'],
  ['Rubik Mono One', 'rubik-mono-one', false, 'display', [400]],
  ['Playfair Display', 'playfair-display', true, 'serif'],
  ['Yeseva One', 'yeseva-one', false, 'serif', [400]],
  ['Lobster', 'lobster', false, 'handwriting', [400]],
  ['Pacifico', 'pacifico', false, 'handwriting', [400]],
  ['Caveat', 'caveat', true, 'handwriting'],
  ['Amatic SC', 'amatic-sc', false, 'handwriting', [400, 700]],
  ['Marck Script', 'marck-script', false, 'handwriting', [400]],
  ['Press Start 2P', 'press-start-2p', false, 'pixel', [400]],
  ['JetBrains Mono', 'jetbrains-mono', true, 'mono'],
];
const SUBSETS = ['latin', 'cyrillic'];

let css = '/* Fonts bundled with StreamHelper (SIL Open Font License 1.1, via fontsource). Generated. */\n';
const manifest = [];
for (const [family, id, variable, category, weights] of FONTS) {
  const pkg = `${variable ? '@fontsource-variable' : '@fontsource'}/${id}`;
  const dir = join(work, id);
  if (!existsSync(join(dir, 'package'))) {
    mkdirSync(dir, { recursive: true });
    const tgz = execSync(`npm pack ${pkg} --silent`, { cwd: dir, encoding: 'utf8' }).trim().split('\n').pop();
    execSync(`tar -xzf "${tgz}"`, { cwd: dir });
  }
  const root = join(dir, 'package');
  const sheets = variable ? ['index.css'] : weights.map((w) => `${w}.css`);
  const faces = [];
  for (const sheet of sheets) {
    const text = readFileSync(join(root, sheet), 'utf8');
    for (const block of text.match(/\/\*[^*]*\*\/\s*@font-face\s*{[^}]*}/g) ?? []) {
      const subset = /\/\*\s*[\w-]+-([\w-]+?)-(?:wght|\d+)-normal\s*\*\//.exec(block)?.[1];
      if (!SUBSETS.includes(subset)) continue;
      const file = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(block)?.[1];
      if (!file) continue;
      mkdirSync(join(out, id), { recursive: true });
      copyFileSync(join(root, 'files', file), join(out, id, file));
      const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1];
      const weight = /font-weight:\s*([^;]+);/.exec(block)?.[1];
      faces.push(`@font-face{font-family:'${family}';font-style:normal;font-display:swap;font-weight:${weight};src:url(./${id}/${file}) format('woff2');unicode-range:${range};}`);
    }
  }
  if (!faces.length) { console.warn('no faces for', family); continue; }
  css += faces.join('\n') + '\n';
  manifest.push({ family, category });
  console.log(family, faces.length);
}
writeFileSync(join(out, 'fonts.css'), css);
writeFileSync(join(out, 'fonts.json'), JSON.stringify(manifest, null, 1) + '\n');
