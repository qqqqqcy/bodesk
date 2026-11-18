import {watch} from 'node:fs';
import {createServer} from 'vite';
import {createMockServer} from '../mock/server.ts';
import {buildExtension, extensionStaticFiles} from './build-extension.ts';

let closing = false;
let activeBuild: Promise<void> | undefined;
let rebuildQueued = false;
let timer: ReturnType<typeof setTimeout> | undefined;
function rebuild() {
  rebuildQueued = true;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (activeBuild || closing) return;
    rebuildQueued = false;
    activeBuild = buildExtension().catch(error => console.error(error)).finally(() => {
      activeBuild = undefined;
      if (rebuildQueued && !closing) rebuild();
    });
  }, 100);
}
rebuild();
const watchers = [
  watch(new URL('../extension/src/', import.meta.url), {recursive: true}, rebuild),
  watch(new URL('../extension/', import.meta.url), (_event, file) => {if (file && extensionStaticFiles.includes(file)) rebuild();}),
];
let vite: Awaited<ReturnType<typeof createServer>>;
const server = createMockServer({webMiddleware: (request, response, next) => vite.middlewares(request, response, next)});
vite = await createServer({server: {middlewareMode: true, hmr: {server}}});
server.listen(4173, '127.0.0.1', () => console.log('Mock BOSS + Vite: http://127.0.0.1:4173/web/geek/chat'));

async function close() {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
  server.close();
  await vite.close();
  await activeBuild;
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
