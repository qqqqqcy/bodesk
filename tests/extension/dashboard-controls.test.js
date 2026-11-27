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

async function chooseDropdown(trigger, text) {
  await trigger.emit('click');
  const item = [...trigger.parentElement.querySelectorAll('[role="option"]')].find(option => option.textContent === text);
  assert.ok(item, text);
  await item.emit('click');
}

test('看板仅在不限时展示无状态时间的收藏职位，公司和职位使用不同图标', async () => {
  const companies=[{id:'company',name:'收藏公司',favorite:true},{id:'company-only',name:'仅收藏公司',favorite:true}];
  const jobs=[{id:'job',title:'无对话职位',status:'awaiting_contact',favorite:true,jobClosed:true,jobClosedObservedAt:Date.now(),companyId:'company'},
    {id:'active',title:'仍在招聘的职位',status:'awaiting_boss',statusAt:Date.now(),companyId:'company'},
    {id:'old',title:'超出日期的职位',status:'awaiting_boss',favorite:true,statusAt:1,companyId:'company'}];
  const {document}=browserHarness(source,async()=>({ok:true,data:{...snapshot(),jobs,companies}}),options);
  await flush();
  assert.equal(document.querySelectorAll('.board-job-row').length,1);
  assert.equal(document.querySelector('#board-status-awaiting_contact'),null);
  const start=document.getElementById('board-activity-start');
  start.value='19';await start.emit('input');
  assert.equal(document.querySelectorAll('.board-job-row').length,3);
  assert.equal(document.querySelector('#board-status-awaiting_contact').textContent,'待沟通');
  const jobIcon=document.querySelector('.board-col-title [aria-label="已收藏职位"] svg');
  const companyIcon=document.querySelector('.board-col-company [aria-label="已收藏公司"] svg');
  assert.ok(jobIcon&&companyIcon);
  assert.notEqual(jobIcon.innerHTML,companyIcon.innerHTML);
  assert.match(document.querySelector('.board-favorite-companies li').textContent,/仅收藏公司/);
  assert.equal(document.querySelector('.board-job-closed').textContent,'职位已关闭');
  assert.equal(document.getElementById('board-availability'),null);
});

test('合并页读取指定账号，同屏展示看板、采集与备份控件', async () => {
  const sent = [];
  const harness = browserHarness(source, async message => {sent.push(message); return {ok: true, data: {...snapshot(), accountNames: {a:'模拟登录名'}}};}, options);
  await flush();
  for (const id of ['account-select', 'sync', 'import', 'export', 'board-activity-start']) assert.ok(harness.document.getElementById(id));
  assert.equal(harness.document.querySelector('nav, #refresh, #stop-sync'), null);
  assert.deepEqual(sent[0], {type: 'DB_GET', account: 'a'});
  const accounts=harness.document.getElementById('account-select');
  assert.equal(accounts.value,'a');
  await accounts.emit('click');
  assert.deepEqual([...harness.document.querySelectorAll('[role="option"]')].map(option=>option.textContent),['模拟登录名','未识别名称的账号 2']);
  assert.match(harness.document.getElementById('conversation-count').textContent, /1$/);
});

test('切换账号后读取新账号，拒绝把其他账号的记录显示在当前账号下', async () => {
  const sent = [];
  let mismatch = false;
  const harness = browserHarness(source, async message => {sent.push(message); return {ok: true, data: snapshot(mismatch ? 'a' : message.account)};}, options);
  await flush();
  const select = harness.document.getElementById('account-select');
  await chooseDropdown(select,'未识别名称的账号 2');
  assert.equal(select.value, 'b');
  assert.ok(sent.some(message => message.type === 'SELECT_ACCOUNT' && message.account === 'b'));
  mismatch = true;
  await harness.notify({type: 'DASHBOARD_CHANGED'});
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
  document.getElementById('board-activity-start').value = '19';
  await document.getElementById('board-activity-start').emit('input');
  assert.equal(document.querySelector('h1').textContent, 'BoDesk');
  assert.deepEqual(Array.from(document.querySelectorAll('.board-table thead th'), heading => heading.textContent),
    ['职位', '公司', '最后一条对话', '状态', '状态说明与备注', '职位条件']);
  const headings = () => Array.from(document.querySelectorAll('.board-group-toggle'), button => button.textContent);
  assert.deepEqual(headings(), ['面试通过', '面试中', '简历已查看', '简历已发送', '待 Boss 回复', '待确认']);
  const viewed = document.querySelector('[aria-labelledby="board-status-resume_viewed"]');
  const rows = viewed.querySelectorAll('.board-job-row');
  assert.equal(rows.length, 2);
  assert.deepEqual(Array.from(rows[0].cells, cell => cell.textContent).slice(0, 2), ['自动识别已查看', '模拟公司']);
  assert.equal(rows[0].querySelector('.board-message-text').textContent, '下周有空沟通吗？');
  const incoming = rows[0].querySelector('.board-message-sender[data-direction="in"]');
  assert.equal(incoming.textContent, '对方');
  assert.equal(incoming.firstChild, incoming.querySelector('.bh-icon'));
  const sender = document.querySelector('.board-message-sender[data-direction="out"]');
  assert.equal(sender.textContent, '自己');
  assert.equal(sender.lastChild, sender.querySelector('.bh-icon'));
  assert.equal(sender.querySelector('svg').getAttribute('aria-hidden'), 'true');
  assert.equal(sender.parentElement.querySelector('[data-receipt="delivered"]').textContent, '已送达');
  assert.equal(rows[0].querySelector('.message-receipt'), null);
  assert.equal(rows[0].querySelector('.board-col-latestMessage time').dateTime, '2026-11-26T10:00:00.000Z');
  assert.equal(rows[0].cells[5].textContent, '25–40K · 上海 · 3–5年 · 本科');
  assert.equal(rows[0].querySelector('details p').textContent, '下周跟进\n准备面试');
  assert.equal(rows[0].querySelector('.board-col-status time').dateTime, '2026-11-25T00:00:00.000Z');
  assert.match(rows[0].querySelector('.board-status-edit').textContent, /附件简历/);
  assert.equal(rows[1].cells[0].textContent, '较早查看');
  assert.equal(rows[1].querySelector('.board-col-conditions').textContent, '—');
  assert.equal(rows[1].querySelector('.board-col-status .board-missing').textContent, '—');
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
  await harness.notify({type: 'DASHBOARD_CHANGED'});
  assert.deepEqual(headings(), ['面试通过', '面试中', '面试失败', '简历已查看', '简历已发送', '待确认']);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  await toggle.emit('click');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(viewed.querySelectorAll('.board-job-row').length, 2);
  const select = document.getElementById('account-select');
  await chooseDropdown(select,'未识别名称的账号 2');
  assert.match(document.querySelector('.job-board').textContent, /当前账号暂无 JD/);
  assert.equal(document.querySelector('.board-job-row'), null);
  assert.equal(document.getElementById('account-select').value, 'b');
  assert.ok(document.getElementById('sync'));
});

test('仅支持状态、公司分组，筛选始终显示且保留旧设置中有效的条件', async () => {
  const jobs=[
    {id:'alpha',title:'前端',companyName:'星河',status:'failed',statusAt:Date.now()},
    {id:'beta',title:'后端',companyName:'星河',status:'interviewing',statusAt:Date.now()},
    {id:'gamma',title:'全栈',companyName:'云帆',status:'passed',statusAt:Date.now()},
  ];
  const {document,window}=browserHarness(source,async()=>({ok:true,data:{...snapshot(),jobs}}),{...options,setup(window) {
    window.localStorage.setItem('boss-helper.jd-board.preferences',JSON.stringify({groupBy:'title',filters:[{column:'title',operator:'excludes',value:'后端'}]}));
  }});
  await flush();
  const group=document.getElementById('board-group-by');
  assert.equal(group.value,'status');
  assert.equal(document.querySelector('select, #board-availability'),null);
  await group.emit('click');
  assert.deepEqual([...document.querySelectorAll('[role="option"]')].map(option=>option.textContent),['状态','公司']);
  await document.querySelector('[role="option"][aria-selected="false"]').emit('click');
  assert.equal(document.querySelectorAll('.board-job-row').length,3);
  assert.equal(document.querySelectorAll('.board-table thead th').length,6);
  const headings=()=>[...document.querySelectorAll('.board-group-toggle')].map(button=>button.textContent).sort();
  assert.deepEqual(headings(),['云帆','星河'].sort());
  const button=text=>[...document.querySelectorAll('#board-filter-panel button')].find(node=>node.textContent===text);
  const operator=document.querySelector('button[aria-label="第 1 条的条件"]');
  await chooseDropdown(operator,'不包含');
  const status=document.querySelector('input[aria-label="第 1 条的值"]');
  status.value='失败';await status.emit('input');
  assert.equal(document.querySelectorAll('.board-job-row').length,2);
  await button('添加筛选').emit('click');
  const companyColumn=document.querySelector('button[aria-label="第 2 条的筛选列"]');
  assert.equal(companyColumn.value,'company');
  const company=document.querySelector('input[aria-label="第 2 条的值"]');
  company.value='星河';await company.emit('input');
  assert.deepEqual(headings(),['星河']);
  assert.equal(document.querySelector('.board-job-title').textContent,'后端');
  const saved=JSON.parse(window.localStorage.getItem('boss-helper.jd-board.preferences'));
  assert.equal(saved.groupBy,'company');assert.equal(saved.filters.length,2);
  await button('清空筛选').emit('click');
  assert.equal(document.querySelectorAll('.board-job-row').length,3);
});

test('JD 看板按真实活动筛选，并保留范围和折叠', async () => {
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
  const slider = () => document.getElementById('board-activity-start');
  const count = () => document.querySelectorAll('.board-job-row').length;
  const summary = document.querySelector('.board-summary');
  assert.equal(document.querySelector('.board-range output'), null);
  const setRange = async (value, expectedCount) => {
    slider().value = String(value);
    await slider().emit('input');
    assert.equal(slider().value, String(value));
    assert.equal(count(), expectedCount);
    assert.ok(summary.querySelector('output').textContent.startsWith('活动时间 ' + slider().getAttribute('aria-valuetext') + ' 至 '));
  };

  assert.equal(slider().value, '7');
  await setRange(19, jobs.length);
  await setRange(1, 3);
  const marksAtOne = () => Array.from(document.querySelectorAll('.board-range-mark')).map(node => ({
    text: node.textContent,
    selected: node.getAttribute('data-selected'),
    nearStart: node.getAttribute('data-near-start'),
    nearEnd: node.getAttribute('data-near-end'),
  }));
  assert.equal(marksAtOne()[0].text, '当天');
  assert.ok(marksAtOne().some(m => m.text === '1 天' && m.selected === 'true' && m.nearStart === 'true'));
  await setRange(16, 5);
  assert.ok(marksAtOne().some(m => m.text === '1 个月' && m.selected === 'true'));
  assert.ok(!marksAtOne().some(m => m.text === '15 天' || m.text === '2 个月'));
  assert.equal(marksAtOne().at(-1).text, '不限');
  await setRange(18, 7);
  assert.ok(marksAtOne().some(m => m.text === '3 个月' && m.selected === 'true' && m.nearEnd === 'true'));
  assert.ok(!marksAtOne().some(m => m.text === '2 个月'));
  await setRange(15, 4);
  await setRange(17, 6);
  await setRange(1, 3);
  await document.querySelector('#board-status-passed button').emit('click');
  assert.equal(count(), 2);
  await harness.notify({type: 'DASHBOARD_CHANGED'});
  assert.equal(slider().value, '1');
  assert.equal(document.querySelector('#board-status-passed button').getAttribute('aria-expanded'), 'false');
  await setRange(19, jobs.length - 1);
  assert.equal(document.querySelector('#board-status-passed button').getAttribute('aria-expanded'), 'false');
});

test('JD 看板从旧偏好恢复开始日期，结束日期可独立选择并包含整天', async () => {
  const midnight = new Date(2026, 10, 26).getTime();
  const now = new Date(2026, 10, 26, 12).getTime();
  const jobs = [
    {id: 'today-status', title: '零点状态更新', status: 'awaiting_boss', statusAt: midnight},
    {id: 'today-chat', title: '今天有消息', status: 'awaiting_boss', statusAt: new Date(2026, 10, 23).getTime(), latestMessage: {text:'你好',direction:'in',time:now - 1000}},
    {id: 'yesterday', title: '昨天有消息', status: 'awaiting_boss', statusAt: midnight - 86400000, latestMessage: {text:'你好',direction:'in',time:midnight - 1000}},
    {id: 'yesterday-start', title: '昨天零点更新', status: 'awaiting_boss', statusAt: new Date(2026, 10, 25).getTime()},
    {id: 'older', title: '更早更新', status: 'awaiting_boss', statusAt: new Date(2026, 10, 24).getTime()},
    {id: 'unknown-time', title: '有消息但缺少状态时间', status: 'awaiting_boss', latestMessage: {text:'你好',direction:'in',time:midnight}},
  ];
  const sent = [];
  const harness = browserHarness(source, async message => {sent.push(message); return {ok: true, data: {...snapshot(), jobs}};}, {...options, setup(window) {
    window.Date.now = () => now;
    window.localStorage.setItem('boss-helper.jd-board.preferences', JSON.stringify({range: 1, collapsed: []}));
  }});
  const {document} = harness;
  await flush();
  const slider = () => document.getElementById('board-activity-start');
  const end = () => document.getElementById('board-activity-end');
  const visibleTitles = () => Array.from(document.querySelectorAll('.board-job-title'), node => node.textContent);
  assert.equal(slider().value, '1');
  assert.equal(end().value, '0');
  assert.equal(slider().getAttribute('aria-valuetext'), '2026/11/25');
  assert.equal(document.querySelector('.board-range-mark').textContent, '当天');
  slider().value = '0';
  await slider().emit('input');
  assert.deepEqual(visibleTitles(), ['零点状态更新', '今天有消息']);
  slider().value = '1';
  await slider().emit('input');
  assert.equal(visibleTitles().length, 4);
  end().value = '1';
  await end().emit('input');
  assert.equal(end().getAttribute('aria-valuetext'), '2026/11/25');
  assert.equal(slider().min, '1');
  assert.equal(end().max, '1');
  assert.deepEqual(visibleTitles().sort(), ['昨天有消息', '昨天零点更新'].sort());
  await document.getElementById('sync').emit('click');
  assert.deepEqual(sent.find(message => message.type === 'SYNC').activityWindow, {start: new Date(2026, 10, 25).getTime(), end: midnight - 1});
  assert.equal(end().value, '1');
  slider().value = '19';
  await slider().emit('input');
  assert.equal(visibleTitles().length, 4);
  assert.equal(end().max, '18');
  end().value='0';await end().emit('input');
  assert.ok(visibleTitles().includes('有消息但缺少状态时间'));
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
  document.getElementById('board-activity-start').value = '19';
  await document.getElementById('board-activity-start').emit('input');
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

test('滑动条按账号加载请求间隔，调整结束后自动保存', async () => {
  const sent = [];
  const intervals = {b: 25};
  const harness = browserHarness(source, async message => {
    sent.push(message);
    if (message.type === 'SET_SYNC_INTERVAL') intervals[message.account] = message.intervalSeconds;
    return {ok: true, data: {...snapshot(message.account), syncIntervalSeconds: intervals[message.account]}};
  }, options);
  await flush();
  const slider = harness.document.getElementById('sync-interval');
  assert.equal(harness.document.getElementById('save-sync-interval'), null);
  assert.equal(slider.min, '1');
  assert.equal(slider.max, '15');
  assert.equal(slider.value, '3');
  slider.value = '1';
  await slider.emit('input');
  assert.equal(slider.getAttribute('aria-valuetext'), '1 秒');
  assert.ok(!sent.some(message => message.type === 'SET_SYNC_INTERVAL'));
  await slider.emit('change');
  assert.deepEqual(sent.find(message => message.type === 'SET_SYNC_INTERVAL'), {type: 'SET_SYNC_INTERVAL', account: 'a', intervalSeconds: 1});
  const account = harness.document.getElementById('account-select');
  await chooseDropdown(account,'未识别名称的账号 2');
  assert.equal(slider.value, '15');
  await chooseDropdown(account,'未识别名称的账号 1');
  assert.equal(slider.value, '1');
});

test('仅在已知总数时显示本次处理进度，使用同一账号的最新计数', async () => {
  let sync = {running: false, processed: 0, total: 0};
  const harness = browserHarness(source, async message => ({ok: true, data: {...snapshot(message.account), sync}}), options);
  await flush();
  assert.equal(harness.document.querySelector('progress'), null);

  sync = {running: true, processed: 4, total: 10, failed: 1};
  await harness.notify({type: 'DASHBOARD_CHANGED'});
  const progress = harness.document.querySelector('progress');
  const syncButton = harness.document.getElementById('sync');
  assert.equal(syncButton.getAttribute('aria-busy'), 'true');
  assert.ok(syncButton.querySelector('svg'));
  assert.equal(progress.value, 4);
  assert.equal(progress.max, 10);
  assert.match(harness.document.getElementById('sync-metadata').textContent, /失败数1/);
  const toggle = harness.document.querySelector('.sync-details-toggle');
  const details = harness.document.getElementById('sync-details');
  assert.equal(details.hidden, true);
  assert.equal(details.previousElementSibling, toggle.closest('.sync-toolbar'));
  assert.equal(progress.closest('#sync-details'), details);
  await toggle.emit('click');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(details.hidden, false);
  const message = '更新结束：5 个会话，0 个失败，0 个历史未读完。';
  sync = {running: false, processed: 5, total: 5, failed: 0, message};
  await harness.notify({type: 'DASHBOARD_CHANGED'});
  assert.equal(details.querySelector('.coverage-note').textContent, message);
  assert.equal(harness.document.querySelector('progress'), null);
  assert.equal(syncButton.getAttribute('aria-busy'), 'false');
  assert.doesNotMatch(harness.document.querySelector('.sync-toolbar').textContent, /本次采集已结束/);
  assert.equal(harness.document.querySelector('#sync-panel').textContent.split(message).length, 2);
  await toggle.emit('click');
  assert.equal(details.hidden, true);
});

test('导出、保存编辑与初始加载期间呈现 pending 态与骨架占位，完成后恢复', async () => {
  let deferGet = true;
  let finishGet;
  let finishExport;
  let finishSave;
  const job = {id: 'job', title: '前端工程师', companyId: 'company', status: 'awaiting_boss', statusAt: Date.now(), note: '原备注'};
  const company = {id: 'company', name: '示例公司', note: ''};
  const payload = () => ({...snapshot(), jobs: [job], companies: [company]});
  const harness = browserHarness(source, async message => {
    if (message.type === 'DB_GET') return deferGet ? new Promise(resolve => {finishGet = resolve;}) : {ok: true, data: payload()};
    if (message.type === 'EXPORT') return new Promise(resolve => {finishExport = resolve;});
    if (message.type === 'SAVE_JOB') return new Promise(resolve => {finishSave = resolve;});
    return {ok: true};
  }, options);
  const {document} = harness;
  await flush();
  const feedback = document.getElementById('feedback');
  assert.equal(feedback.getAttribute('data-pending'), 'true');
  assert.ok(feedback.querySelector('.bh-spinner svg'));
  assert.equal(document.querySelector('.board-empty').getAttribute('data-loading'), 'true');
  assert.ok(document.querySelector('.board-skeleton'));

  deferGet = false;
  finishGet({ok: true, data: payload()});
  await flush();
  assert.equal(document.querySelector('.board-skeleton'), null);
  assert.equal(feedback.getAttribute('data-pending'), null);

  const exportButton = document.getElementById('export');
  const exporting = exportButton.emit('click');
  await flush();
  assert.equal(exportButton.getAttribute('aria-busy'), 'true');
  assert.equal(exportButton.disabled, true);
  assert.equal(exportButton.textContent, '导出中…');
  assert.ok(exportButton.querySelector('.bh-spinner svg'));
  finishExport({ok: true, data: {account: 'a'}});
  await exporting;
  assert.equal(exportButton.getAttribute('aria-busy'), 'false');
  assert.equal(exportButton.disabled, false);
  assert.equal(exportButton.textContent, '导出 JSON');

  await document.querySelector('.board-col-detail .board-note-edit').emit('click');
  const dialog = document.querySelector('.board-edit-dialog');
  const textarea = dialog.querySelector('textarea');
  textarea.value = '新备注';
  await textarea.emit('input');
  const saveButton = dialog.querySelector('.button.primary');
  const saving = dialog.querySelector('form').emit('submit');
  await flush();
  assert.equal(saveButton.getAttribute('aria-busy'), 'true');
  assert.equal(saveButton.disabled, true);
  assert.equal(saveButton.textContent, '正在保存…');
  assert.ok(saveButton.querySelector('.bh-spinner svg'));
  finishSave({ok: true});
  await saving;
  assert.equal(document.querySelector('.board-edit-dialog'), null);
});
