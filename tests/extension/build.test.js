import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import vm from 'node:vm';
import {registerBuildReload} from '../../extension/src/build-reload.ts';

const extension = new URL('../../extension/', import.meta.url);
test('成功构建发布可供扩展识别的版本标记', async () => {
  assert.match(await readFile(new URL('dist/revision.txt', extension), 'utf8'), /^[a-f0-9]{64}\n$/);
});

test('构建变化后等待编辑和采集结束，重载后只刷新本地模拟页', async context => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  context.after(() => {globalThis.chrome = previousChrome; globalThis.fetch = previousFetch;});
  const storage = {};
  const refreshed = [];
  let alarmListener;
  let revision = 'a'.repeat(64);
  let editing = true;
  let syncing = true;
  let reloads = 0;
  globalThis.fetch = async () => new Response(revision);
  globalThis.chrome = {
    alarms: {get: async () => ({}), onAlarm: {addListener: listener => {alarmListener = listener;}}},
    runtime: {getURL: path => 'chrome-extension://test/' + path, reload: () => {reloads++;}},
    storage: {local: {get: async key => ({[key]: storage[key]}), set: async values => Object.assign(storage, values)}},
    tabs: {
      query: async ({url}) => url.some(pattern => pattern.startsWith('https://www.zhipin.com/')) ? [{id: 1}, {id: 2}] : [{id: 2}],
      sendMessage: async id => ({ready: id !== 1 || !editing}),
      reload: async id => {refreshed.push(id);},
    },
  };
  const whenIdle = async reload => {if (!syncing) await reload();};
  const flush = () => new Promise(resolve => setImmediate(resolve));
  async function check() {
    alarmListener({name: 'boss-helper-build'});
    await flush();
  }

  registerBuildReload(whenIdle);
  await flush();
  assert.equal(reloads, 0);
  revision = 'b'.repeat(64);
  await check();
  assert.equal(reloads, 0);
  editing = false;
  await check();
  assert.equal(reloads, 0);
  syncing = false;
  await check();
  assert.equal(reloads, 1);
  assert.deepEqual(refreshed, []);

  registerBuildReload(whenIdle);
  await flush();
  await check();
  assert.equal(reloads, 1);
  assert.deepEqual(refreshed, [2]);
});

test('同一份扩展清单中的所有入口都存在，两个内容脚本可作为经典脚本加载', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', extension), 'utf8'));
  assert.equal(manifest.background.type, 'module');
  assert.ok((await stat(new URL(manifest.background.service_worker, extension))).isFile());
  for (const entry of manifest.content_scripts) {
    for (const path of entry.js) {
      const source = await readFile(new URL(path, extension), 'utf8');
      assert.doesNotThrow(() => new vm.Script(source, {filename: path}));
      assert.doesNotMatch(source, /@vite\/client|localhost:5173|react-refresh/);
    }
    for (const path of entry.css || []) assert.ok((await stat(new URL(path, extension))).isFile());
  }
});

test('采集页只引用构建包内的模块和样式，符合扩展 CSP', async () => {
  const page = new URL('dist/dashboard.html', extension);
  const html = await readFile(page, 'utf8');
  assert.match(html, /<script type="module"/);
  const assets = [...html.matchAll(/(?:src|href)="([^\"]+)"/g)].map(match => match[1]);
  assert.ok(assets.some(path => path.endsWith('.js')));
  assert.ok(assets.some(path => path.endsWith('.css')));
  for (const path of assets) {
    assert.ok(path.startsWith('./'));
    assert.ok((await stat(new URL(path, page))).isFile());
  }
  assert.doesNotMatch(html, /https?:|@vite\/client|<script(?![^>]*\bsrc=)[^>]*>/);
});
