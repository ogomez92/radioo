// Copies the built proc-audio-capture binary into resources/ so electron-builder
// picks it up via extraResources.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const exe = process.platform === 'win32' ? 'proc-audio-capture.exe' : 'proc-audio-capture';
const src = join('native', 'proc-audio-capture', 'target', 'release', exe);
const destDir = join('resources', 'proc-audio-capture');
const dest = join(destDir, exe);

if (!existsSync(src)) {
  console.error(`[copy-sidecar] missing build artifact: ${src}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-sidecar] ${src} -> ${dest}`);
