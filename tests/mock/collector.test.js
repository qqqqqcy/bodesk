import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto, createHash} from 'node:crypto';
import {clientFor} from './support/client.js';
import {inferStatus} from '../../extension/dist/core.js';

async function collect(context, {scenario = 'normal', stopAfterPage = false, switchAfterPage = false, allRows = false, activityWindow} = {}) {
  const client = await clientFor(context);
  const source = (await readFile(new URL('../../extension/dist/main.js', import.meta.url), 'utf8'))
    .replace(/const MOCK_ORIGIN\s*=\s*["']http:\/\/127\.0\.0\.1:4173["'];/, 'const MOCK_ORIGIN=' + JSON.stringify(client.origin) + ';');
  await client.json('/__mock/state', {scenario});
  const config = await client.json('/__mock/state');
  const listing = await client.json('/__mock/list');
  const rows = allRows ? listing.rows : listing.rows.slice(0, 1);
  const account = createHash('sha256').update('boss:mock:' + config.user.userId).digest('hex').slice(0, 24);
  const output = [];
  const user = {$options: {name: 'App'}, $store: {state: {userInfo: {...config.user}}}};
  const list = {$options: {name: 'boss-list'}, fullList: rows, isLoading: false, bottomText: listing.ended ? '没有更多了' : '加载更多'};
  const document = {documentElement: null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: tag => tag === '*' ? [{__vue__: user}, {__vue__: list}] : []};
  let listener;
  const began = performance.now();
  const window = {
    addEventListener: (name, handler) => {if (name === 'message') listener = handler;},
    fetch: async address => {
      const url = new URL(address);
      const response = await client.request(url.pathname + url.search);
      if (switchAfterPage && url.pathname.endsWith('historyMsg')) user.$store.state.userInfo.userId = 'other-mock-user';
      return response;
    },
    postMessage: event => {
      const data = event.data;
      output.push(data);
      if (data.requestId) queueMicrotask(() => {
        deliver({type: 'INGEST_ACK', account: data.account, runId: data.runId, requestId: data.requestId, ok: true});
        if (stopAfterPage && data.type === 'CONVERSATION') deliver({type: 'STOP_SYNC', commandId: 'stop', runId: 'test-run'});
      });
    }
  };
  function deliver(data) {listener({source: window, origin: client.origin, data: {channel: 'boss-local-helper-v1', direction: 'to-page', data}});}
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function() {};
  XMLHttpRequest.prototype.send = function() {};
  const timers = new Set(), delays = [];
  const sandbox = {window, document, location: {origin: client.origin, pathname: '/web/geek/chat'}, XMLHttpRequest,
    crypto: webcrypto, TextEncoder, URL, AbortController, performance: {now: () => (performance.now() - began) * 1000},
    setTimeout: (callback, duration) => {
      delays.push(duration);
      const timer = setTimeout(() => {timers.delete(timer); callback();}, duration === 15000 ? 2000 : Math.ceil(duration / 1000));
      timers.add(timer);
      return timer;
    }, clearTimeout: timer => {timers.delete(timer); clearTimeout(timer);}, setInterval() {}, MutationObserver: class {observe() {}}};
  context.after(() => {for (const timer of timers) clearTimeout(timer);});
  vm.runInNewContext(source, sandbox);
  async function run(commandId, runId) {
    const previous = output.filter(event => event.type === 'SYNC_PROGRESS' && !event.sync.running).length;
    deliver({type: 'SYNC', commandId, runId, account, activityWindow});
    const deadline = Date.now() + 4000;
    while (output.filter(event => event.type === 'SYNC_PROGRESS' && !event.sync.running).length === previous) {
      if (Date.now() > deadline) throw new Error('源插件采集没有结束');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await new Promise(resolve => setImmediate(resolve));
    return output.findLast(event => event.type === 'SYNC_PROGRESS').sync;
  }
  const final = await run('start', 'test-run');
  return {output, client, final, delays, account, retry: () => run('retry', 'test-retry')};
}

test('原插件 MAIN 脚本通过真实 HTTP 采集三页并保留账号与字段约定', async context => {
  const result = await collect(context, {scenario: 'multipage'});
  assert.equal(result.final.complete, true);
  const records = result.output.filter(event => event.type === 'CONVERSATION');
  assert.deepEqual(records.map(event => event.messages.length), [20, 20, 5]);
  assert.equal(new Set(records.flatMap(event => event.messages.map(message => message.id))).size, 45);
  assert.equal(records[2].history.serverReportsEnd, true);
  assert.equal(records[2].history.count, 45);
  assert.ok(records[0].detail.companyName);
  assert.ok(records.flatMap(event => event.messages).some(message => message.direction === 'out'));
  assert.ok(!JSON.stringify(records).includes('synthetic-local-only'));
  assert.ok(records.every(record => record.account === result.account));
  assert.ok(!result.delays.includes(3000));
  assert.ok(!result.delays.includes(20000));
  assert.equal((await result.client.json('/__mock/list')).rows[0].unreadCount, 2);
});

test('模拟 HTTP 历史跨页时只保存所选时间并在下界停止', async context => {
  const base = Date.UTC(2026, 10, 16, 2);
  const activityWindow = {start: base + 30 * 60000, end: base + 36 * 60000};
  const {final, output} = await collect(context, {scenario: 'multipage', activityWindow});
  const pages = output.filter(event => event.type === 'CONVERSATION');
  const times = pages.flatMap(page => Array.from(page.messages, message => message.time));
  assert.equal(final.complete, true);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].history.serverReportsEnd, false);
  assert.equal(times.length, 7);
  assert.equal(Math.min(...times), activityWindow.start);
  assert.equal(Math.max(...times), activityWindow.end);
});

test('原插件采集全部 normal 夹具并保留状态证据和空历史', async context => {
  const result = await collect(context, {allRows: true});
  assert.equal(result.final.complete, true);
  const records = result.output.filter(event => event.type === 'CONVERSATION');
  assert.equal(records.length, 16);
  const inferred = records.map(record => inferStatus(record.row, record.messages));
  for (const status of ['resume_event', 'resume_requested', 'awaiting_self', 'awaiting_boss', 'unknown'])
    assert.ok(inferred.some(item => item.status === status), status);
  assert.equal(records[7].messages.length, 0);
  assert.equal(inferred[6].status, 'resume_event');
  assert.equal(inferred[9].status, 'awaiting_boss');
  assert.match(inferred[8].evidence, /审核/);
  assert.equal(inferred[11].status, 'resume_requested');
  assert.match(records[11].messages.at(0).text, /希望获取您的附件简历/);
  assert.match(records[12].row.name, /<script>.*__xss/);
});

test('原插件采集方向缺失和简历提示时间冲突', async context => {
  const direction = await collect(context, {scenario: 'unknown_direction', allRows: true});
  const records = direction.output.filter(event => event.type === 'CONVERSATION');
  assert.ok(records[0].messages.every(message => message.direction === 'unknown'));
  assert.equal(inferStatus(records[0].row, records[0].messages).status, 'awaiting_boss');
  assert.equal(inferStatus(records[2].row, records[2].messages).status, 'unknown');
  const ambiguous = await collect(context, {scenario: 'ambiguous_resume', allRows: true});
  const conflicts = ambiguous.output.filter(event => event.type === 'CONVERSATION');
  assert.match(inferStatus(conflicts[0].row, conflicts[0].messages).evidence, /时间相同/);
  assert.match(inferStatus(conflicts[1].row, conflicts[1].messages).evidence, /缺失时间/);
  assert.equal(inferStatus(conflicts[2].row, conflicts[2].messages).status, 'resume_event');
});

test('原插件检测第二页 429 并保留已确认第一页', async context => {
  const result = await collect(context, {scenario: 'rate_limit'});
  assert.equal(result.final.complete, false);
  assert.equal(result.final.failed, 1);
  assert.equal(result.output.filter(event => event.type === 'CONVERSATION').length, 1);
  assert.match(result.final.message, /429/);
  const retried = await result.retry();
  assert.match(retried.message, /429/);
  assert.equal(result.output.find(event => event.type === 'COMMAND_RESULT' && event.commandId === 'retry').ok, true);
  assert.equal((await result.client.json('/__mock/requests')).length, 6);
});

test('原插件检测游标停滞，阻止无限翻页', async context => {
  const result = await collect(context, {scenario: 'stalled'});
  assert.equal(result.final.complete, false);
  assert.match(result.final.message, /游标停滞/);
  assert.equal(result.output.filter(event => event.type === 'CONVERSATION').length, 2);
});

test('空账号完成零请求采集，部分加载列表不宣称完整', async context => {
  const empty = await collect(context, {scenario: 'empty'});
  assert.equal(empty.final.complete, true);
  assert.equal((await empty.client.json('/__mock/requests')).length, 0);
  const partial = await collect(context, {scenario: 'partial'});
  assert.equal(partial.final.complete, false);
  assert.equal(partial.final.failed, 0);
});

test('停止后保留第一页，账号切换后丢弃响应', async context => {
  const stopped = await collect(context, {scenario: 'multipage', stopAfterPage: true});
  assert.equal(stopped.final.complete, false);
  assert.equal(stopped.final.failed, 0);
  assert.equal(stopped.output.filter(event => event.type === 'CONVERSATION').length, 1);
  const switched = await collect(context, {switchAfterPage: true});
  assert.equal(switched.output.filter(event => event.type === 'CONVERSATION').length, 0);
  assert.match(switched.final.message, /账号已切换/);
});
