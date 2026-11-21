// Offline audit of the packaged application. Does not run or install StreamHelper/OBS.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync, writeFileSync, createReadStream } = require('node:fs');
const { join, resolve, relative } = require('node:path');
const asar = require('@electron/asar');

const root = resolve(__dirname,'..');
const version = JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
const output = join(root,'dist',version);
const archive = join(output,'win-unpacked/resources/app.asar');
const files = (dir) => readdirSync(dir,{ withFileTypes:true }).flatMap((entry) => entry.isDirectory()?files(join(dir,entry.name)):[join(dir,entry.name)]);
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
const hashFile = async (path, algorithm, encoding) => { const hash=createHash(algorithm); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest(encoding); };

(async () => {
  const packaged = JSON.parse(asar.extractFile(archive,'package.json').toString());
  assert.equal(packaged.version,version);
  let codeFiles=0,overlayFiles=0,browserExtensionFiles=0;
  for (const file of files(join(root,'out'))) {
    const path=relative(root,file);
    assert.equal(digest(asar.extractFile(archive,path)),digest(readFileSync(file)),`Packaged code mismatch: ${path}`);
    codeFiles++;
  }
  for (const file of files(join(root,'resources/overlays'))) {
    const path=relative(join(root,'resources/overlays'),file);
    assert.equal(digest(readFileSync(join(output,'win-unpacked/resources/overlays',path))),digest(readFileSync(file)),`Packaged overlay mismatch: ${path}`);
    overlayFiles++;
  }
  for (const file of files(join(root,'resources/browser-music'))) {
    const path=relative(join(root,'resources/browser-music'),file);
    assert.equal(digest(readFileSync(join(output,'win-unpacked/resources/browser-music',path))),digest(readFileSync(file)),`Packaged browser extension mismatch: ${path}`);
    browserExtensionFiles++;
  }
  const listing=asar.listPackage(archive).map(p=>p.replace(/^[/\\]/,''));
  assert(!listing.some(p=>p.endsWith('secrets.bin')),'Secrets must not be packaged');
  assert(listing.includes(join('src','main','winrt','generated','index.js')),'Windows media bindings missing');
  assert(listing.includes(join('node_modules','@microsoft','signalr','package.json')),'DonateX SignalR client missing');
  const natives=listing.filter(p=>p.endsWith('.node'));
  assert(natives.length>0,'Native modules missing');
  assert(natives.some(p=>p.includes('win32-x64')),'Windows x64 native module missing');
  for(const path of natives) {
    assert(asar.statFile(archive,path).unpacked,`Native file must be outside asar: ${path}`);
    const file=join(archive+'.unpacked',path);
    assert(existsSync(file),`Unpacked native file missing: ${path}`);
    const bytes=readFileSync(file); assert.equal(bytes.toString('ascii',0,2),'MZ');
    const offset=bytes.readUInt32LE(0x3c); assert.equal(bytes.readUInt16LE(offset+4),path.includes('arm64')?0xAA64:0x8664,`Native file architecture mismatch: ${path}`);
  }
  const manifest=readFileSync(join(output,'latest.yml'),'utf8');
  assert.equal(/^version: (.+)$/m.exec(manifest)[1],version);
  const installerName=`StreamHelper-Setup-${version}.exe`;
  const installer=join(output,installerName);
  assert.equal(await hashFile(installer,'sha512','base64'),/^sha512: (.+)$/m.exec(manifest)[1],'Installer SHA512 mismatch');
  const sha256=await hashFile(installer,'sha256','hex');
  const checksums=readFileSync(join(output,'SHA256SUMS.txt'),'utf8').trim().split(/\r?\n/);
  for (const name of [installerName,`${installerName}.blockmap`,'latest.yml']) {
    const sha=name===installerName?sha256:await hashFile(join(output,name),'sha256','hex');
    assert(checksums.includes(`${sha}  ${name}`),`Release asset SHA256 mismatch: ${name}`);
  }
  const result={ passed:true,version,codeFiles,overlayFiles,browserExtensionFiles,nativeFiles:natives.length,installerSha256:sha256 };
  writeFileSync(join(output,'package-verification.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
