import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = new URL('../', import.meta.url);
let checked = 0;
for (const directory of ['extension', 'mock', 'tests', 'scripts', 'research']) {
  const files = await readdir(new URL(directory + '/', root), {recursive: true});
  for (const file of files.filter(file => file.endsWith('.js')).sort()) {
    const filename = fileURLToPath(new URL(directory + '/' + file, root));
    const result = spawnSync(process.execPath, ['--check', filename], {stdio: 'inherit'});
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    checked++;
  }
}
console.log(`Syntax checked ${checked} JavaScript files.`);
