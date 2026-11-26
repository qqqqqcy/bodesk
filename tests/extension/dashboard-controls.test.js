import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {browserHarness, flush} from './support/dom.js';

const bundle = await build({
  configFile: false,
  logLevel: 'silent',
  build: {write: false, minify: false, rolldownOptions: {
    input: fileURLToPath(new URL('../../extension/dist/dashboard.js', import.meta.url)),
    output: {format: 'iife'},
  }},
});
const source = bundle.output.find(file => file.type === 'chunk' && file.isEntry).code;
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

test('JD 看板支持独立折叠，组内按状态时间排序', async () => {
  const jobs = [
    {id: 'early', title: '刚开始沟通', status: 'awaiting_boss', updatedAt: 100},
    {id: 'sent', title: '已发简历', status: 'resume_event', autoLabel: '您的附件简历已发送给Boss'},
    {id: 'manual', title: '手动通过', status: 'awaiting_boss', manualStatus: 'passed', statusAt: Date.UTC(2026, 10, 25), latestMessage: {text: '好的，谢谢', direction: 'out', time: 0, receipt: 'delivered'}},
    {
      id: 'viewed', title: '自动识别已查看', status: 'resume_event', autoLabel: '对方已查看了您的附件简历',
      statusAt: Date.UTC(2026, 10, 25), companyId: 'company', url: 'http://127.0.0.1:4173/job_detail/mock.html?extra=1',
      salary: '25–40K', location: '上海', experience: '3–5年', degree: '本科', note: '下周跟进\n准备面试',
      latestMessage: {text: '下周有空沟通吗？', direction: 'in', time: Date.UTC(2026, 10, 26, 10)},
    },
    {id: 'legacy', title: '旧面试记录', status: 'interview_2'},
    {id: 'other', title: '较早查看', status: 'resume_viewed', updatedAt: Date.UTC(2026, 10, 26), url: 'javascript:alert(1)'},
    {id: 'unknown', title: '未知职位', status: 'future_status'},
  ];
  const harness = browserHarness(source, async message => ({ok: true, data: {
    ...snapshot(message.account), jobs: message.account === 'a' ? jobs : [], companies: [{id: 'company', name: '模拟公司'}],
  }}), options);
  const {document} = harness;
  await flush();
  await document.querySelector('[href="#board"]').emit('click');
  assert.equal(document.querySelector('h1').textContent, 'JD 看板');
  assert.deepEqual(Array.from(document.querySelectorAll('.board-table thead th'), heading => heading.textContent),
    ['职位', '公司', '最后一条对话', '状态时间', '状态说明与备注', '职位条件']);
  const headings = () => Array.from(document.querySelectorAll('.board-group-toggle'), button => button.textContent);
  assert.deepEqual(headings(), ['面试通过', '面试中', '简历已查看', '简历已发送', '待 Boss 回复', '待确认']);
  const viewed = document.querySelector('[aria-labelledby="board-status-resume_viewed"]');
  const rows = viewed.querySelectorAll('.board-job-row');
  assert.equal(rows.length, 2);
  assert.deepEqual(Array.from(rows[0].cells, cell => cell.textContent).slice(0, 2), ['自动识别已查看', '模拟公司']);
  assert.equal(rows[0].querySelector('.board-message-text').textContent, '下周有空沟通吗？');
  assert.equal(rows[0].querySelector('.board-message-sender[data-direction="in"]').textContent, '对方');
  const sender = document.querySelector('.board-message-sender[data-direction="out"]');
  assert.equal(sender.textContent, '自己');
  assert.equal(sender.querySelector('svg').getAttribute('aria-hidden'), 'true');
  assert.equal(sender.parentElement.querySelector('[data-receipt="delivered"]').textContent, '已送达');
  assert.equal(rows[0].querySelector('.message-receipt'), null);
  assert.equal(rows[0].querySelector('.board-col-latestMessage time').dateTime, '2026-11-26T10:00:00.000Z');
  assert.equal(rows[0].cells[5].textContent, '25–40K · 上海 · 3–5年 · 本科');
  assert.equal(rows[0].querySelector('details p').textContent, '下周跟进\n准备面试');
  assert.equal(rows[0].querySelector('.board-col-statusAt time').dateTime, '2026-11-25T00:00:00.000Z');
  assert.equal(rows[1].cells[0].textContent, '较早查看');
  assert.equal(rows[1].querySelector('.board-col-conditions').textContent, '—');
  assert.equal(rows[1].querySelector('.board-col-statusAt .board-missing').textContent, '—');
  assert.match(document.querySelector('#board-status-passed').closest('.board-group').querySelector('time').title, /手动/);
  assert.equal(viewed.querySelector('a').href, 'http://127.0.0.1:4173/job_detail/mock.html');
  assert.equal(viewed.querySelectorAll('a').length, 1);
  const toggle = viewed.querySelector('.board-group-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  await toggle.emit('click');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(viewed.querySelectorAll('.board-job-row').length, 0);
  assert.equal(document.querySelectorAll('.board-job-row').length, jobs.length - 2);
  assert.match(viewed.querySelector('.board-count').textContent, /2 个 JD/);
  jobs[0].status = 'failed';
  await document.getElementById('refresh').emit('click');
  assert.deepEqual(headings(), ['面试通过', '面试中', '面试失败', '简历已查看', '简历已发送', '待确认']);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  await toggle.emit('click');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(viewed.querySelectorAll('.board-job-row').length, 2);
  const select = document.getElementById('account-select');
  select.value = 'b'; await select.emit('change');
  assert.match(document.querySelector('.job-board').textContent, /当前账号暂无 JD/);
  assert.equal(document.querySelector('.board-job-row'), null);
  await document.querySelector('[href="#collection"]').emit('click');
  assert.equal(document.getElementById('account-select').value, 'b');
  assert.ok(document.getElementById('sync'));
});

test('JD 看板按真实活动筛选，并在离开后恢复范围和折叠', async () => {
  const ago = days => Date.now() - days * 86400000;
  const jobs = [
    {id: 'status', title: '最近换状态', status: 'passed', statusAt: ago(0.5)},
    {id: 'message', title: '最近有新对话', status: 'awaiting_boss', statusAt: ago(45), latestMessage: {text: '好的', direction: 'in', time: ago(0.5)}},
    {id: 'restore', title: '最近恢复自动', status: 'interviewing', statusAt: ago(45), statusActivityAt: ago(0.5)},
    {id: 'days', title: '十天内', status: 'awaiting_boss', statusAt: ago(10)},
    {id: 'month', title: '一个月内', status: 'awaiting_boss', statusAt: ago(24)},
    {id: 'two-months', title: '两个月内', status: 'awaiting_boss', statusAt: ago(45)},
    {id: 'three-months', title: '三个月内', status: 'awaiting_boss', statusAt: ago(75)},
    {id: 'unknown', title: '只有采集时间', status: 'unknown', updatedAt: Date.now()},
  ];
  const harness = browserHarness(source, async () => ({ok: true, data: {...snapshot(), jobs}}), {...options, url: options.url + '#board'});
  const {document} = harness;
  await flush();
  const slider = () => document.getElementById('board-activity-range');
  const count = () => document.querySelectorAll('.board-job-row').length;
  const setRange = async (value, label, expectedCount) => {
    slider().value = String(value);
    await slider().emit('input');
    assert.equal(slider().getAttribute('aria-valuetext'), label);
    assert.equal(count(), expectedCount);
  };

  assert.equal(slider().value, '19');
  assert.equal(count(), jobs.length);
  await setRange(1, '最近 1 天', 3);
  await setRange(15, '最近 15 天', 4);
  await setRange(16, '最近 1 个月', 5);
  await setRange(17, '最近 2 个月', 6);
  await setRange(18, '最近 3 个月', 7);
  await setRange(1, '最近 1 天', 3);
  await document.querySelector('#board-status-passed button').emit('click');
  assert.equal(count(), 2);
  await document.querySelector('[href="#collection"]').emit('click');
  await document.querySelector('[href="#board"]').emit('click');
  assert.equal(slider().value, '1');
  assert.equal(document.querySelector('#board-status-passed button').getAttribute('aria-expanded'), 'false');
  await setRange(19, '不限', jobs.length - 1);
  assert.equal(document.querySelector('#board-status-passed button').getAttribute('aria-expanded'), 'false');
});

test('JD 看板当天档位以本地零点为界，独立于最近 1 天', async () => {
  const midnight = new Date(2026, 10, 26).getTime();
  const now = new Date(2026, 10, 26, 12).getTime();
  const jobs = [
    {id: 'today-status', title: '零点状态更新', status: 'awaiting_boss', statusAt: midnight},
    {id: 'today-chat', title: '今天有消息', status: 'awaiting_boss', latestMessage: {text:'你好',direction:'in',time:now - 1000}},
    {id: 'yesterday', title: '昨天有消息', status: 'awaiting_boss', latestMessage: {text:'你好',direction:'in',time:midnight - 1000}},
  ];
  const harness = browserHarness(source, async () => ({ok: true, data: {...snapshot(), jobs}}), {...options, url: options.url + '#board'});
  harness.window.Date.now = () => now;
  const {document} = harness;
  await flush();
  const slider = document.getElementById('board-activity-range');
  const visibleTitles = () => Array.from(document.querySelectorAll('.board-job-title'), node => node.textContent);
  assert.equal(slider.min, '0');
  assert.equal(document.querySelector('.board-range-mark').textContent, '当天');
  slider.value = '0';
  await slider.emit('input');
  assert.equal(slider.getAttribute('aria-valuetext'), '当天');
  assert.deepEqual(visibleTitles(), ['零点状态更新', '今天有消息']);
  slider.value = '1';
  await slider.emit('input');
  assert.equal(slider.getAttribute('aria-valuetext'), '最近 1 天');
  assert.equal(visibleTitles().length, 3);
});

test('看板可编辑公司和 JD 备注，确认状态后即时重新分组', async () => {
  const job = {id: 'job', title: '前端工程师', companyId: 'company', status: 'awaiting_boss', note: ' 原备注 '};
  const company = {id: 'company', name: '示例公司', note: ''};
  const writes = [];
  let conflict = true;
  const harness = browserHarness(source, async message => {
    if (message.type === 'DB_GET') return {ok: true, data: {...snapshot(), jobs: [job], companies: [company]}};
    writes.push(message);
    if (message.type === 'SAVE_COMPANY_NOTE') company.note = message.note;
    if (message.type === 'SAVE_JOB' && Object.hasOwn(message, 'note')) {
      if (conflict) return {ok: false, error: '备注冲突'};
      job.note = message.note;
    }
    if (message.type === 'SAVE_JOB' && message.status) job.status = job.manualStatus = message.status;
    return {ok: true};
  }, {...options, url: options.url + '#board'});
  const {document} = harness;
  const editor = () => document.querySelector('.board-edit-dialog');
  const enterNote = async note => {
    const input = editor().querySelector('textarea');
    input.value = note;
    await input.emit('input');
    await editor().querySelector('form').emit('submit');
  };
  await flush();
  await document.querySelector('.board-col-company .board-note-edit').emit('click');
  await enterNote('公司备注');
  assert.equal(editor(), null);
  assert.equal(document.querySelector('.board-col-company details p').textContent, '公司备注');
  assert.deepEqual(writes[0], {type:'SAVE_COMPANY_NOTE', account:'a', companyId:'company', companyName:'示例公司', note:'公司备注', expectedNote:''});

  await document.querySelector('.board-col-detail .board-note-edit').emit('click');
  await enterNote('新的 JD 备注');
  assert.match(editor().querySelector('[role="alert"]').textContent, /备注冲突/);
  assert.equal(editor().querySelector('textarea').value, '新的 JD 备注');
  assert.equal(writes[1].expectedNote, ' 原备注 ');
  conflict = false;
  await editor().querySelector('form').emit('submit');
  assert.equal(editor(), null);
  assert.equal(document.querySelector('.board-col-detail details p').textContent, '新的 JD 备注');

  await document.querySelector('.board-status-edit').emit('click');
  await editor().querySelector('[value="passed"]').emit('click');
  assert.match(editor().querySelector('h2').textContent, /确认修改/);
  assert.equal(writes.length, 3);
  await editor().querySelector('.button.primary').emit('click');
  assert.equal(editor(), null);
  assert.equal(document.querySelector('#board-status-passed').textContent, '面试通过');
  assert.deepEqual(writes[3], {type:'SAVE_JOB', account:'a', jobId:'job', status:'passed', expectedManualStatus:null});
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

test('滑动条按账号加载请求间隔，改动在点击保存后才提交', async () => {
  const sent = [];
  const intervals = {b: 15};
  const harness = browserHarness(source, async message => {
    sent.push(message);
    if (message.type === 'SET_SYNC_INTERVAL') intervals[message.account] = message.intervalSeconds;
    return {ok: true, data: {...snapshot(message.account), syncIntervalSeconds: intervals[message.account]}};
  }, options);
  await flush();
  const slider = harness.document.getElementById('sync-interval');
  const save = harness.document.getElementById('save-sync-interval');
  assert.equal(slider.min, '1');
  assert.equal(slider.value, '3');
  assert.equal(save.disabled, true);
  slider.value = '1';
  await slider.emit('input');
  assert.equal(slider.getAttribute('aria-valuetext'), '1 秒');
  assert.ok(!sent.some(message => message.type === 'SET_SYNC_INTERVAL'));
  await save.emit('click');
  assert.deepEqual(sent.find(message => message.type === 'SET_SYNC_INTERVAL'), {type: 'SET_SYNC_INTERVAL', account: 'a', intervalSeconds: 1});
  assert.equal(save.disabled, true);
  const account = harness.document.getElementById('account-select');
  account.value = 'b';
  await account.emit('change');
  assert.equal(slider.value, '15');
  account.value = 'a';
  await account.emit('change');
  assert.equal(slider.value, '1');
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
