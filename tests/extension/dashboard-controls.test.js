import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {formatBoardMarkdown} from '../../extension/src/board-export.ts';
import {formatRelativeStatusDate} from '../../extension/src/status.ts';
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

test('同一份看板数据随当前时间纳入新活动，并在跨日后更新行内日期', async () => {
  const start = new Date(2025, 4, 10, 23, 58).getTime();
  let now = start;
  const jobs = [{id: 'first', title: '已有职位', statusAt: start}, {id: 'later', title: '稍后出现', statusAt: start + 60000}];
  const {document} = browserHarness(source, async () => ({ok: true, data: {...snapshot(), jobs}}), {
    ...options, setup: window => {window.Date.now = () => now;},
  });
  await flush();
  const dates = () => [...document.querySelectorAll('.board-job-row time')].map(time => time.textContent);
  assert.deepEqual(dates(), ['当天']);
  now += 60000;
  await document.querySelector('.sync-details-toggle').emit('click');
  assert.deepEqual(dates(), ['当天', '当天']);
  now += 60000;
  await document.querySelector('.sync-details-toggle').emit('click');
  assert.deepEqual(dates(), ['1 天内', '1 天内']);
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
  assert.equal(rows[0].querySelector('.board-col-latestMessage time').textContent, formatRelativeStatusDate(Date.UTC(2026, 10, 26, 10)));
  assert.match(rows[0].querySelector('.board-col-latestMessage time').title, /^对话消息时间：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  assert.equal(rows[0].cells[5].textContent, '25–40K · 上海 · 3–5年 · 本科');
  assert.equal(rows[0].querySelector('details'), null);
  assert.equal(rows[0].querySelector('.board-note').textContent, '下周跟进\n准备面试');
  assert.equal(rows[0].querySelector('.board-note').title, '下周跟进\n准备面试');
  assert.equal(rows[0].querySelector('.board-col-status time').dateTime, '2026-11-25T00:00:00.000Z');
  assert.equal(rows[0].querySelector('.board-col-status time').textContent, formatRelativeStatusDate(Date.UTC(2026, 10, 25)));
  assert.match(rows[0].querySelector('.board-col-status time').title, /^判断当前状态所依据的消息时间：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  assert.match(rows[0].querySelector('.board-status-edit').textContent, /附件简历/);
  assert.equal(rows[1].cells[0].textContent, '较早查看');
  assert.equal(rows[1].querySelector('.board-col-conditions').textContent, '—');
  assert.equal(rows[1].querySelector('.board-col-status .board-missing').textContent, '—');
  assert.match(document.querySelector('#board-status-passed').closest('.board-group').querySelector('time').title, /^手动设置当前状态的时间：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  assert.equal(viewed.querySelector('a').href, 'http://127.0.0.1:4173/job_detail/mock.html');
  assert.equal(viewed.querySelectorAll('a').length, 1);
  const toggle = viewed.querySelector('.board-group-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  await toggle.emit('click');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(viewed.querySelectorAll('.board-job-row').length, 0);
  assert.equal(document.querySelectorAll('.board-job-row').length, jobs.length - 2);
  assert.match(viewed.querySelector('.board-count').textContent, /2 个 JD/);
  await viewed.querySelector('.board-group-row th').emit('click');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(viewed.querySelectorAll('.board-job-row').length, 2);
  await viewed.querySelector('.board-count').emit('click');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(viewed.querySelectorAll('.board-job-row').length, 0);
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
  assert.deepEqual([...document.querySelectorAll('[role="option"]')].map(option=>option.textContent),['状态','公司','收藏']);
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
  assert.equal(document.querySelector('.board-col-company .board-note').textContent, '公司备注');
  assert.equal(document.querySelector('.board-col-company .board-note').title, '公司备注');
  assert.deepEqual(writes[0], {type:'SAVE_COMPANY_NOTE', account:'a', companyId:'company', companyName:'示例公司', note:'公司备注', expectedNote:''});

  await document.querySelector('.board-col-detail .board-note-edit').emit('click');
  await enterNote('新的 JD 备注');
  assert.match(editor().querySelector('[role="alert"]').textContent, /备注冲突/);
  assert.equal(editor().querySelector('textarea').value, '新的 JD 备注');
  assert.equal(writes[1].expectedNote, ' 原备注 ');
  conflict = false;
  await editor().querySelector('form').emit('submit');
  assert.equal(editor(), null);
  assert.equal(document.querySelector('.board-col-detail .board-note').textContent, '新的 JD 备注');
  assert.equal(document.querySelector('.board-col-detail .board-note').title, '新的 JD 备注');

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
  const payload = {...snapshot(), jobs: [{id: 'a:job:1', title: '前端工程师', status: 'awaiting_boss', statusAt: Date.now()}]};
  const harness = browserHarness(source, async message => message.type === 'EXPORT' ? {ok: false, error: '模拟导出失败'} : {ok: true, data: payload}, options);
  await flush();
  const button = harness.document.getElementById('export');
  await button.emit('click');
  await harness.document.getElementById('export-file-option').emit('click');
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
  await exportButton.emit('click');
  const exporting = document.getElementById('export-file-option').emit('click');
  await flush();
  assert.equal(exportButton.getAttribute('aria-busy'), 'true');
  assert.equal(exportButton.disabled, true);
  assert.equal(exportButton.textContent, '导出中…');
  assert.ok(exportButton.querySelector('.bh-spinner svg'));
  finishExport({ok: true, data: {account: 'a', jobs: [job]}});
  await exporting;
  assert.equal(exportButton.getAttribute('aria-busy'), 'false');
  assert.equal(exportButton.disabled, false);
  assert.equal(exportButton.textContent, '导出');

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

test('看板支持删除 JD 记录：确认、取消、并发版本检查、失败重试与 pending 态', async () => {
  const now = Date.now();
  let jobs = [
    {id: 'a:job:first', title: '前端架构师', status: 'interviewing', statusAt: now, updatedAt: 123456, companyId: 'c1'},
    {id: 'a:job:no-ts', title: '无更新时间职位', status: 'awaiting_boss', statusAt: now, companyId: 'c1'},
  ];
  const deleted = [];
  let failDelete = true;
  let deferDelete = false;
  let finishDelete;

  const harness = browserHarness(source, async message => {
    if (message.type === 'DB_GET') return {ok: true, data: {...snapshot(), jobs: jobs.map(j => ({...j})), companies: [{id: 'c1', name: '星河科技'}]}};
    if (message.type === 'DELETE_JOB') {
      deleted.push(message);
      if (deferDelete) return new Promise(resolve => {finishDelete = resolve;});
      if (failDelete) return {ok: false, error: '职位已更改，请刷新后重新删除'};
      jobs = jobs.filter(j => j.id !== message.jobId);
      return {ok: true};
    }
    return {ok: true};
  }, options);
  const {document} = harness;
  await flush();

  const rowDeleteButtons = () => [...document.querySelectorAll('.board-job-row .board-job-delete')];
  assert.equal(rowDeleteButtons().length, 2);
  assert.equal(rowDeleteButtons()[0].getAttribute('aria-label'), '删除 前端架构师');

  // Open and cancel
  await rowDeleteButtons()[0].emit('click');
  let dialog = document.querySelector('.board-edit-dialog');
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('h2').textContent, '删除「前端架构师」的职位记录？');
  assert.match(dialog.textContent, /清除此 JD 的本地备注和状态/);
  assert.equal(deleted.length, 0);
  await dialog.querySelector('.button:not(.danger)').emit('click');
  assert.equal(document.querySelector('.board-edit-dialog'), null);
  assert.equal(deleted.length, 0);

  // Confirm failure keeps dialog open and displays error, retry with pending succeeds
  await rowDeleteButtons()[0].emit('click');
  dialog = document.querySelector('.board-edit-dialog');
  await dialog.querySelector('.button.danger').emit('click');
  assert.equal(deleted.length, 1);
  assert.deepEqual(deleted[0], {type: 'DELETE_JOB', account: 'a', jobId: 'a:job:first', expectedUpdatedAt: 123456});
  assert.match(dialog.querySelector('.board-edit-error').textContent, /刷新后重新删除/);
  assert.equal(dialog.open, true);

  failDelete = false;
  deferDelete = true;
  const confirmButton = dialog.querySelector('.button.danger');
  const pendingDelete = confirmButton.emit('click');
  await flush();
  assert.equal(confirmButton.getAttribute('aria-busy'), 'true');
  assert.equal(confirmButton.disabled, true);
  assert.equal(confirmButton.textContent, '正在删除…');
  assert.ok(confirmButton.querySelector('.bh-spinner svg'));
  jobs = jobs.filter(j => j.id !== 'a:job:first');
  finishDelete({ok: true});
  await pendingDelete;

  assert.equal(document.querySelector('.board-edit-dialog'), null);
  assert.equal(document.getElementById('feedback').textContent, '已删除职位记录');
  assert.deepEqual([...document.querySelectorAll('.board-job-row .board-job-title')].map(el => el.textContent), ['无更新时间职位']);

  // Job without updatedAt omits expectedUpdatedAt
  deferDelete = false;
  await document.querySelector('.board-job-row .board-job-delete').emit('click');
  dialog = document.querySelector('.board-edit-dialog');
  await dialog.querySelector('.button.danger').emit('click');
  assert.deepEqual(deleted.at(-1), {type: 'DELETE_JOB', account: 'a', jobId: 'a:job:no-ts'});
  assert.equal(document.querySelectorAll('.board-job-row').length, 0);
  assert.equal(document.getElementById('feedback').textContent, '已删除职位记录');
});

test('看板支持按收藏分组与筛选，并持久化及恢复收藏条件', async () => {
  const now = Date.now();
  const companies = [
    {id: 'c-fav', name: '星河科技', favorite: true},
    {id: 'c-plain', name: '云帆数据', favorite: false},
  ];
  const jobs = [
    {id: 'j-both', title: '双收藏架构师', status: 'interviewing', statusAt: now, favorite: true, companyId: 'c-fav'},
    {id: 'j-job-only', title: '仅职位收藏前端', status: 'passed', statusAt: now, favorite: true, companyId: 'c-plain'},
    {id: 'j-comp-only', title: '仅公司收藏后端', status: 'awaiting_self', statusAt: now, favorite: false, companyId: 'c-fav'},
    {id: 'j-none', title: '未收藏全栈', status: 'resume_sent', statusAt: now, favorite: false, companyId: 'c-plain'},
  ];

  // Restores valid favorite group & filter preferences while discarding malformed favorite filters
  const restored = browserHarness(source, async () => ({ok: true, data: {...snapshot(), companies, jobs}}), {
    ...options,
    setup(window) {
      window.localStorage.setItem('boss-helper.jd-board.preferences', JSON.stringify({
        groupBy: 'favorite',
        filters: [
          {column: 'favorite', operator: 'contains', value: 'any'},
          {column: 'favorite', operator: 'equals', value: 'bad-value'},
          {column: 'favorite', operator: 'equals', value: 'company'},
        ],
      }));
    },
  });
  await flush();
  assert.equal(restored.document.getElementById('board-group-by').value, 'favorite');
  assert.equal(restored.document.querySelectorAll('#board-filter-panel .board-filter-row').length, 1);
  assert.deepEqual(
    [...restored.document.querySelectorAll('.board-job-row .board-job-title')].map(el => el.textContent),
    ['双收藏架构师', '仅公司收藏后端']
  );

  // Fresh board: test favorite grouping and all filter combinations
  const harness = browserHarness(source, async () => ({ok: true, data: {...snapshot(), companies, jobs}}), options);
  const {document, window} = harness;
  await flush();
  const statusTime = document.querySelector('.board-job-row .board-col-status time.board-time');
  assert.equal(statusTime.textContent, '当天');
  assert.match(statusTime.title, /^判断当前状态所依据的消息时间：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);

  const group = document.getElementById('board-group-by');
  await chooseDropdown(group, '收藏');
  assert.equal(document.querySelectorAll('.board-table thead th').length, 6);
  const headings = () => [...document.querySelectorAll('.board-group-toggle')].map(button => button.textContent);
  assert.deepEqual(headings(), ['已收藏职位', '已收藏公司', '未收藏']);

  // Collapse middle group and verify collapse persists in state
  await document.querySelector('#board-favorite-company button').emit('click');
  assert.equal(document.querySelectorAll('.board-job-row').length, 3);
  await document.querySelector('#board-favorite-company button').emit('click');
  assert.equal(document.querySelectorAll('.board-job-row').length, 4);

  // Switch filter column to 收藏 -> defaults to 等于 + 已收藏
  const colSelect = document.querySelector('button[aria-label="第 1 条的筛选列"]');
  await chooseDropdown(colSelect, '收藏');
  const opSelect = () => document.querySelector('button[aria-label="第 1 条的条件"]');
  const valSelect = () => document.querySelector('button[aria-label="第 1 条的值"]');
  assert.equal(opSelect().value, 'equals');
  assert.equal(valSelect().tagName, 'BUTTON');
  assert.equal(valSelect().value, 'any');
  assert.equal(document.querySelector('input[aria-label="第 1 条的值"]'), null);
  const titles = () => [...document.querySelectorAll('.board-job-row .board-job-title')].map(el => el.textContent).sort();
  assert.deepEqual(titles(), ['仅公司收藏后端', '仅职位收藏前端', '双收藏架构师'].sort());

  // Switch value to 已收藏职位 / 已收藏公司 / 未收藏
  await chooseDropdown(valSelect(), '已收藏职位');
  assert.deepEqual(titles(), ['仅职位收藏前端', '双收藏架构师'].sort());
  await chooseDropdown(valSelect(), '已收藏公司');
  assert.deepEqual(titles(), ['仅公司收藏后端', '双收藏架构师'].sort());
  await chooseDropdown(valSelect(), '未收藏');
  assert.deepEqual(titles(), ['未收藏全栈']);

  // Switch operator to 不等于 -> excludes 未收藏 (shows all favorited)
  await chooseDropdown(opSelect(), '不等于');
  assert.deepEqual(titles(), ['仅公司收藏后端', '仅职位收藏前端', '双收藏架构师'].sort());

  const saved = JSON.parse(window.localStorage.getItem('boss-helper.jd-board.preferences'));
  assert.equal(saved.groupBy, 'favorite');
  assert.deepEqual(saved.filters, [{column: 'favorite', operator: 'differs', value: 'none'}]);

  // Switch column back to 状态 -> resets operator to contains and restores text input
  await chooseDropdown(colSelect, '状态');
  assert.equal(opSelect().value, 'contains');
  assert.equal(document.querySelector('input[aria-label="第 1 条的值"]').tagName, 'INPUT');
  assert.equal(document.querySelectorAll('.board-job-row').length, 4);
});

test('导出二级菜单说明当前筛选范围，按筛选与活动时间导出并禁用空结果', async () => {
  const now = Date.now();
  const jobs = [
    {id: 'a:job:1', title: '面试职位', status: 'interviewing', statusAt: now, companyId: 'c1'},
    {id: 'a:job:2', title: '通过职位', status: 'passed', statusAt: now, companyId: 'c1'},
    {id: 'a:job:3', title: '早期职位', status: 'awaiting_boss', statusAt: 1, companyId: 'c1'},
  ];
  const sent = [];
  const harness = browserHarness(source, async message => {
    sent.push(message);
    if (message.type === 'EXPORT') return {ok: true, data: {account: 'a', jobs: message.jobIds.map(id => jobs.find(j => j.id === id))}};
    return {ok: true, data: {...snapshot(), companies: [{id: 'c1', name: '示例公司'}], jobs}};
  }, {
    ...options,
    setup(window) {
      window.URL.createObjectURL = () => 'blob:mock';
      window.URL.revokeObjectURL = () => {};
    },
  });
  const {document} = harness;
  await flush();

  const exportButton = document.getElementById('export');
  await exportButton.emit('click');
  assert.equal(document.querySelector('.action-menu-hint').textContent, '仅导出当前筛选结果（2 / 3 个 JD）');
  await document.getElementById('export-file-option').emit('click');
  assert.deepEqual(sent.at(-1), {type: 'EXPORT', account: 'a', jobIds: ['a:job:1', 'a:job:2']});
  assert.equal(document.getElementById('feedback').textContent, '已开始导出当前筛选的 2 个 JD JSON，请在浏览器下载列表查看');

  const input = document.querySelector('input[aria-label="第 1 条的值"]');
  input.value = '面试中';
  await input.emit('input');
  await exportButton.emit('click');
  assert.equal(document.querySelector('.action-menu-hint').textContent, '仅导出当前筛选结果（1 / 3 个 JD）');
  await document.getElementById('export-file-option').emit('click');
  assert.deepEqual(sent.at(-1), {type: 'EXPORT', account: 'a', jobIds: ['a:job:1']});

  input.value = '不存在状态';
  await input.emit('input');
  await exportButton.emit('click');
  assert.equal(document.querySelector('.action-menu-hint').textContent, '仅导出当前筛选结果（暂无可导出的 JD）');
  assert.equal(document.getElementById('export-markdown-copy-option').disabled, true);
  assert.equal(document.getElementById('export-markdown-file-option').disabled, true);
  assert.equal(document.getElementById('export-file-option').disabled, true);
  assert.equal(document.getElementById('export-copy-option').disabled, true);
});

test('导出支持复制 JSON 内容到剪贴板并处理剪贴板失败', async () => {
  const now = Date.now();
  const job = {id: 'a:job:1', title: '前端工程师', status: 'interviewing', statusAt: now};
  const payload = {account: 'a', jobs: [job], companies: [], conversations: [], messages: [], events: []};
  let copied = '';
  let failCopy = false;
  const harness = browserHarness(source, async message => {
    if (message.type === 'EXPORT') return {ok: true, data: payload};
    return {ok: true, data: {...snapshot(), jobs: [job]}};
  }, {
    ...options,
    setup(window) {
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: {
          async writeText(text) {
            if (failCopy) throw new Error('Denied');
            copied = text;
          },
        },
      });
    },
  });
  const {document} = harness;
  await flush();

  await document.getElementById('export').emit('click');
  await document.getElementById('export-copy-option').emit('click');
  assert.equal(copied, JSON.stringify(payload, null, 2));
  assert.equal(document.getElementById('feedback').textContent, '已复制当前筛选的 1 个 JD JSON 到剪贴板');

  failCopy = true;
  await document.getElementById('export').emit('click');
  await document.getElementById('export-copy-option').emit('click');
  assert.match(document.getElementById('feedback').textContent, /复制到剪贴板失败/);
  assert.ok(document.getElementById('feedback').classList.contains('error'));
});

test('导入二级菜单支持从文件导入和粘贴 JSON 导入弹窗（校验、报错保留、pending 态与刷新）', async () => {
  let fileClicked = 0;
  let deferImport = false;
  let finishImport;
  let rejectImport = true;
  const sent = [];
  const harness = browserHarness(source, async message => {
    sent.push(message);
    if (message.type === 'IMPORT') {
      if (rejectImport) return {ok: false, error: '内容不是有效的 JSON'};
      if (deferImport) return new Promise(resolve => {finishImport = resolve;});
      return {ok: true, account: 'a', added: 4, skipped: 1};
    }
    return {ok: true, data: snapshot()};
  }, options);
  const {document} = harness;
  await flush();

  document.getElementById('import-file').addEventListener('click', () => {fileClicked++;});
  await document.getElementById('import').emit('click');
  await document.getElementById('import-file-option').emit('click');
  assert.equal(fileClicked, 1);

  await document.getElementById('import').emit('click');
  await document.getElementById('import-paste-option').emit('click');
  const dialog = document.querySelector('.backup-import-dialog');
  assert.ok(dialog);
  assert.equal(dialog.querySelector('h2').textContent, '粘贴 JSON 导入');

  await dialog.querySelector('form').emit('submit');
  assert.equal(dialog.querySelector('.board-edit-error').textContent, '请先粘贴 JSON 内容');
  assert.equal(sent.some(m => m.type === 'IMPORT'), false);

  const textarea = dialog.querySelector('textarea');
  textarea.value = '{';
  await textarea.emit('input');
  await dialog.querySelector('form').emit('submit');
  assert.equal(sent.filter(m => m.type === 'IMPORT').length, 1);
  assert.ok(document.querySelector('.backup-import-dialog'));
  assert.equal(textarea.value, '{');
  assert.equal(dialog.querySelector('.board-edit-error').textContent, '内容不是有效的 JSON');

  rejectImport = false;
  deferImport = true;
  const validJson = '{"account":"' + 'a'.repeat(24) + '","companies":[],"jobs":[],"conversations":[],"messages":[],"events":[]}';
  textarea.value = '  ' + validJson + '  ';
  await textarea.emit('input');
  const submitButton = dialog.querySelector('.button.primary');
  const submitting = dialog.querySelector('form').emit('submit');
  await flush();
  assert.equal(submitButton.getAttribute('aria-busy'), 'true');
  assert.equal(submitButton.disabled, true);
  assert.equal(submitButton.textContent, '导入中…');
  assert.equal(document.getElementById('import').getAttribute('aria-busy'), 'true');

  finishImport({ok: true, account: 'a', added: 4, skipped: 1});
  await submitting;
  assert.deepEqual(sent.at(-2), {type: 'IMPORT', json: validJson});
  assert.equal(sent.at(-1).type, 'DB_GET');
  assert.equal(document.querySelector('.backup-import-dialog'), null);
  assert.equal(document.getElementById('feedback').textContent, '已导入 4 条记录，跳过 1 条已有记录');
});

test('formatBoardMarkdown 按分组、筛选、标签与多行内容生成供 AI 分析的可读摘要', () => {
  const now = new Date('2026-11-27T11:00:00').getTime();
  const earlier = now - 3600_000;
  const jobs = [
    {
      id: 'j-older', title: '初级前端', company: '星河科技', companyId: 'c1', companyNote: '团队氛围好\n两轮技术面',
      companyFavorite: true, favorite: false, jobClosed: false, jobClosedObservedAt: 0,
      conditions: ['20-30K', '上海'], status: 'awaiting_self', detail: '', note: '', url: 'https://www.zhipin.com/job_detail/j2.html',
      statusAt: earlier, statusActivityAt: 0, messageActivity: [], manual: false, manualStatus: null, statusText: '待自己回复',
      latestMessage: {text: '请查收面试题', direction: 'in', time: earlier},
    },
    {
      id: 'j-newer', title: '前端架构师', company: '星河科技', companyId: 'c1', companyNote: '团队氛围好\n两轮技术面',
      companyFavorite: true, favorite: true, jobClosed: true, jobClosedObservedAt: now,
      conditions: ['40-60K', '上海', '5-10年', '本科'], status: 'interviewing', detail: '手动设置',
      note: '重点岗位\n周三二面', url: 'https://www.zhipin.com/job_detail/j1.html',
      statusAt: now, statusActivityAt: 0, messageActivity: [], manual: true, manualStatus: 'interviewing', statusText: '面试中',
      latestMessage: {text: '收到\n准时参加', direction: 'out', receipt: 'read', time: now},
    },
  ];

  const byFavorite = formatBoardMarkdown({
    jobs,
    totalCount: 5,
    preferences: {
      range: 7,
      rangeEnd: 0,
      collapsed: [],
      groupBy: 'favorite',
      filters: [
        {column: 'company', operator: 'contains', value: '星河科技'},
        {column: 'status', operator: 'contains', value: '   '},
      ],
    },
    now,
    accountName: '林知夏',
  });
  assert.match(byFavorite, /^# BoDesk JD 看板摘要/m);
  assert.match(byFavorite, /- 账号：林知夏/);
  assert.match(byFavorite, /- 分组方式：按收藏/);
  assert.match(byFavorite, /- 筛选条件：公司 包含「星河科技」$/m);
  assert.match(byFavorite, /- 统计：当前筛选 2 \/ 5 个 JD，共 2 组（已收藏职位 1、已收藏公司 1）/);
  assert.ok(byFavorite.indexOf('## 已收藏职位（1 个 JD）') < byFavorite.indexOf('## 已收藏公司（1 个 JD）'));
  assert.match(byFavorite, /### 1\. 前端架构师｜星河科技/);
  assert.match(byFavorite, /- 标签：已收藏职位、已收藏公司、职位已关闭（2026\/11\/27 11:00）/);
  assert.match(byFavorite, /- 状态：面试中（手动设置，2026\/11\/27 11:00 · 当天）/);
  assert.match(byFavorite, /- 职位条件：40-60K · 上海 · 5-10年 · 本科/);
  assert.match(byFavorite, /- 最后对话：自己（已读，2026\/11\/27 11:00 · 当天）：\n  收到\n  准时参加/);
  assert.match(byFavorite, /- JD 备注：\n  重点岗位\n  周三二面/);
  assert.match(byFavorite, /- 公司备注：\n  团队氛围好\n  两轮技术面/);

  const byCompany = formatBoardMarkdown({
    jobs,
    totalCount: 2,
    preferences: {range: 19, rangeEnd: 0, collapsed: [], groupBy: 'company', filters: []},
    now,
  });
  assert.doesNotMatch(byCompany, /- 账号：/);
  assert.match(byCompany, /- 筛选条件：无/);
  assert.match(byCompany, /- 统计：共 2 个 JD，共 1 组（星河科技 2）/);
  assert.match(byCompany, /## 星河科技（2 个 JD）\n\n### 1\. 前端架构师\n/);
  assert.ok(byCompany.indexOf('### 1. 前端架构师') < byCompany.indexOf('### 2. 初级前端'));
});

test('导出菜单按分组呈现 AI 易读摘要，支持复制 Markdown 与下载 .md 文件', async () => {
  const now = Date.now();
  const jobs = [
    {
      id: 'a:job:1', title: '前端架构师', status: 'interviewing', statusAt: now, favorite: true, companyId: 'c1',
      latestMessage: {text: '已约周三终面', direction: 'out', receipt: 'read', time: now}, note: '二面重点准备',
    },
    {id: 'a:job:2', title: '全栈工程师', status: 'passed', statusAt: now, favorite: false, companyId: 'c2'},
  ];
  const companies = [
    {id: 'c1', name: '星河科技', favorite: true},
    {id: 'c2', name: '云帆数据', favorite: false},
  ];
  const sent = [];
  let copied = '';
  let failCopy = false;
  let downloadedBlob = null;
  let downloadName = '';
  const harness = browserHarness(source, async message => {
    sent.push(message);
    return {ok: true, data: {...snapshot(), accountNames: {a: '求职主账号'}, jobs, companies}};
  }, {
    ...options,
    setup(window) {
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: {
          async writeText(text) {
            if (failCopy) throw new Error('Denied');
            copied = text;
          },
        },
      });
      window.URL.createObjectURL = blob => {
        downloadedBlob = blob;
        return 'blob:markdown';
      };
      window.URL.revokeObjectURL = () => {};
      const origClick = window.HTMLAnchorElement.prototype.click;
      window.HTMLAnchorElement.prototype.click = function(...args) {
        downloadName = this.download;
        return origClick.apply(this, args);
      };
    },
  });
  const {document} = harness;
  await flush();

  const group = document.getElementById('board-group-by');
  await chooseDropdown(group, '收藏');
  const filterInput = document.querySelector('input[aria-label="第 1 条的值"]');
  await chooseDropdown(document.querySelector('button[aria-label="第 1 条的筛选列"]'), '公司');
  filterInput.value = '星河科技';
  await filterInput.emit('input');

  await document.getElementById('export').emit('click');
  const sectionTitles = [...document.querySelectorAll('.action-menu-section-title')].map(el => el.textContent);
  assert.deepEqual(sectionTitles, ['易读摘要 · 用于 AI 分析', '数据备份 · 可重新导入']);

  await document.getElementById('export-markdown-copy-option').emit('click');
  assert.equal(sent.some(m => m.type === 'EXPORT'), false);
  assert.equal(document.getElementById('feedback').textContent, '已复制当前筛选的 1 个 JD 摘要（Markdown）到剪贴板');
  assert.match(copied, /# BoDesk JD 看板摘要/);
  assert.match(copied, /- 分组方式：按收藏/);
  assert.match(copied, /## 已收藏职位（1 个 JD）/);
  assert.match(copied, /### 1\. 前端架构师｜星河科技/);
  assert.match(copied, /- JD 备注：二面重点准备/);
  assert.doesNotMatch(copied, /云帆数据/);

  await document.getElementById('export').emit('click');
  await document.getElementById('export-markdown-file-option').emit('click');
  assert.match(downloadName, /^BoDesk-看板摘要-.*\.md$/);
  assert.equal(downloadedBlob.type, 'text/markdown;charset=utf-8');
  assert.match(await downloadedBlob.text(), /## 已收藏职位（1 个 JD）/);
  assert.equal(document.getElementById('feedback').textContent, '已开始导出当前筛选的 1 个 JD 摘要（Markdown），请在浏览器下载列表查看');

  failCopy = true;
  await document.getElementById('export').emit('click');
  await document.getElementById('export-markdown-copy-option').emit('click');
  assert.match(document.getElementById('feedback').textContent, /复制到剪贴板失败/);
  assert.ok(document.getElementById('feedback').classList.contains('error'));
});
