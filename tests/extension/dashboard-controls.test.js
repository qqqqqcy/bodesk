import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {browserHarness, flush} from './support/dom.js';

const source = readFileSync(new URL('../../extension/dist/dashboard.js', import.meta.url), 'utf8');
const snapshot = (account = 'a') => ({account, accounts: ['a', 'b'], conversations: [{}], sync: {running: false, processed: 1, total: 1}});
const options = {url: 'https://extension.test/dist/dashboard.html?account=a'};

test('React 采集页读取指定账号，保留同步与导出控件', async () => {
  const sent = [];
  const harness = browserHarness(source, async message => {sent.push(message); return {ok: true, data: snapshot()};}, options);
  await flush();
  for (const id of ['account-select', 'refresh', 'sync', 'stop-sync', 'export', 'conversation-count']) assert.ok(harness.document.getElementById(id));
  for (const id of ['company-list', 'job-count', 'company-filter', 'status-filter', 'delete-from-link']) assert.equal(harness.document.getElementById(id), null);
  assert.deepEqual(sent[0], {type: 'DB_GET', account: 'a'});
  assert.equal(harness.document.getElementById('conversation-count').textContent, '1');
  assert.equal(harness.document.getElementById('stop-sync').disabled, true);
});

test('切换账号后读取新账号，拒绝把其他账号的记录显示在当前账号下', async () => {
  const sent = [];
  let mismatch = false;
  const harness = browserHarness(source, async message => {sent.push(message); return {ok: true, data: snapshot(mismatch ? 'a' : message.account)};}, options);
  await flush();
  const select = harness.document.getElementById('account-select');
  select.value = 'b'; await select.emit('change');
  assert.equal(select.value, 'b');
  assert.ok(sent.some(message => message.type === 'SELECT_ACCOUNT' && message.account === 'b'));
  mismatch = true;
  await harness.document.getElementById('refresh').emit('click');
  assert.equal(select.value, 'b');
  assert.match(harness.document.getElementById('feedback').textContent, /账号.*不一致/);
});

test('同步请求仍在等待时可以停止，两个命令始终携带同一账号', async () => {
  const sent = [];
  let finishSync;
  const harness = browserHarness(source, async message => {
    sent.push(message);
    if (message.type === 'SYNC') return new Promise(resolve => {finishSync = resolve;});
    return {ok: true, data: snapshot()};
  }, options);
  await flush();
  const running = harness.document.getElementById('sync').emit('click');
  await flush();
  assert.equal(harness.document.getElementById('stop-sync').disabled, false);
  await harness.document.getElementById('stop-sync').emit('click');
  assert.ok(sent.some(message => message.type === 'STOP_SYNC' && message.account === 'a'));
  finishSync({ok: true}); await running;
  assert.equal(harness.document.getElementById('sync').disabled, false);
});

test('导出失败会显示错误，恢复按钮状态', async () => {
  const harness = browserHarness(source, async message => message.type === 'EXPORT' ? {ok: false, error: '模拟导出失败'} : {ok: true, data: snapshot()}, options);
  await flush();
  const button = harness.document.getElementById('export');
  await button.emit('click');
  assert.match(harness.document.getElementById('feedback').textContent, /模拟导出失败/);
  assert.equal(button.disabled, false);
});

test('仅在已知总数时显示本次处理进度，使用同一账号的最新计数', async () => {
  let sync = {running: false, processed: 0, total: 0};
  const harness = browserHarness(source, async message => ({ok: true, data: {...snapshot(message.account), sync}}), options);
  await flush();
  assert.equal(harness.document.querySelector('progress'), null);

  sync = {running: true, processed: 4, total: 10, failed: 1};
  await harness.document.getElementById('refresh').emit('click');
  const progress = harness.document.querySelector('progress');
  assert.equal(progress.value, 4);
  assert.equal(progress.max, 10);
  assert.match(harness.document.getElementById('sync-progress').textContent, /失败1/);
});
