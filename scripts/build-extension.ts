import {createHash} from 'node:crypto';
import {cp, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {extensionConfig} from '../vite.extension.config.ts';

const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const output = join(extension, 'dist');
export const extensionStaticFiles = [
  'manifest.json',
  'content.css',
  'assets/icon.svg',
  'assets/icon-16.png',
  'assets/icon-32.png',
  'assets/icon-48.png',
  'assets/icon-128.png',
];

export async function buildExtension() {
  const staging = await mkdtemp(join(tmpdir(), 'boss-helper-build-'));
  try {
    for (const target of ['pages', 'content', 'main'] as const) {
      const config = extensionConfig(target);
      await build({...config, build: {...config.build, outDir: staging}});
    }
    const hash = createHash('sha256');
    for (const file of extensionStaticFiles) hash.update(await readFile(join(extension, file)));
    const files = await readdir(staging, {recursive: true, withFileTypes: true});
    for (const file of files.filter(file => file.isFile()).map(file => join(file.parentPath, file.name)).sort()) {
      hash.update(await readFile(file));
    }
    await mkdir(output, {recursive: true});
    await cp(staging, output, {recursive: true});
    const temporary = join(output, '.revision-' + process.pid);
    await writeFile(temporary, hash.digest('hex') + '\n');
    await rename(temporary, join(output, 'revision.txt'));
  } finally {
    await rm(staging, {recursive: true, force: true});
  }
}
