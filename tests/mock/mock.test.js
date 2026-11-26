import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SCENARIOS, createWorld, historyPage, appendMessage} from '../../mock/fixtures.ts';
import {clientFor} from './support/client.js';
import {inferStatus, mergeJob} from '../../extension/dist/core.js';

// Mirror the fields retained by MAIN's cleanRow / cleanMessage before calling the real status rules.
function cleanMessages(world, conversation) {
  return conversation.messages.map(message => ({id: message.mid, time: message.time || 0, type: message.type, bodyType: message.body.type,
    isSystem: message.body.type === 4 ? true : null,
    direction: message.from?.uid === world.user.userId ? 'out' : message.to?.uid === world.user.userId ? 'in' : 'unknown',
    status: message.status, text: [message.body.text, message.body.dialog?.title, message.body.dialog?.content, message.body.dialog?.text].filter(Boolean).join('\n')}));
}

function inferConversation(world, conversation) {
  const row = conversation.row;
  return inferStatus({unread: typeof row.unreadCount === 'number' ? row.unreadCount > 0 : null,
    lastIsSelf: row.lastIsSelf, lastText: row.lastText, lastMessageAt: row.lastTS}, cleanMessages(world, conversation));
}

test('固定夹具覆盖同公司多 JD、同 JD 多人、缺少 JD 与未知未读', () => {
  const world = createWorld();
  const rows = world.conversations.map(item => item.row);
  assert.equal(rows.length, 16);
  assert.equal(rows[0].brandName, rows[1].brandName);
  assert.notEqual(rows[0].encryptJobId, rows[1].encryptJobId);
  assert.equal(rows[0].encryptJobId, rows[4].encryptJobId);
  assert.equal(rows[5].encryptJobId, '');
  assert.equal(rows[5].unreadCount, null);
  const star = world.conversations.filter(item => item.row.brandName === '星河科技');
  assert.ok(new Set(star.map(item => item.row.encryptJobId)).size >= 4);
  const earliest = star.filter(item => item.messages.length).map(item => Math.min(...item.messages.map(message => message.time)));
  assert.equal(new Set(earliest).size, earliest.length);
  assert.deepEqual(star.find(item => item.key === 'no_messages').messages, []);
  assert.match(rows.find(row => row.encryptJobId.endsWith('safe-text')).jobName, /<script>.*__xss/);
  assert.ok(rows.find(row => row.encryptJobId.endsWith('safe-text')).jobName.length > 200);
  assert.deepEqual(createWorld(), world);
  assert.notEqual(createWorld({account: 'beta'}).user.userId, world.user.userId);
});

test('normal 全会话使用插件规则覆盖状态、简历标签、撤回与卡片', () => {
  const world = createWorld();
  const results = new Map(world.conversations.map(item => [item.key, inferConversation(world, item)]));
  for (const status of ['resume_event', 'resume_requested', 'awaiting_self', 'awaiting_boss', 'unknown'])
    assert.ok([...results.values()].some(result => result.status === status), status);
  assert.ok(new Set([...results.values()].filter(result => result.status === 'resume_event').map(result => result.label)).size >= 2);
  const earlier = world.conversations.find(item => item.key === 'earlier_resume');
  assert.ok(earlier.messages.slice(2).every(message => message.body.type === 1));
  assert.equal(results.get('earlier_resume').status, 'resume_event');
  assert.equal(results.get('earlier_resume').observedAt, earlier.messages[1].time);
  assert.equal(results.get('withdrawn').status, 'awaiting_boss');
  assert.match(results.get('withdrawn').evidence, /项目介绍/);
  const card = world.conversations.find(item => item.key === 'dialog_request').messages.at(-1);
  assert.equal(card.body.type, 7);
  assert.equal(card.body.text, '');
  assert.match(card.body.dialog.content, /希望获取您的附件简历/);
  assert.equal(results.get('dialog_request').status, 'resume_requested');
  assert.equal(results.get('unknown_resume').status, 'unknown');
  assert.match(results.get('unknown_resume').evidence, /审核/);
  assert.equal(results.get('system_only').status, 'unknown');
  assert.equal(results.get('no_messages').status, 'unknown');
});

test('方向缺失回退列表或待确认；简历提示同时间或缺失时间待确认', () => {
  const direction = createWorld({scenario: 'unknown_direction'});
  assert.equal(inferConversation(direction, direction.conversations[0]).status, 'awaiting_boss');
  assert.equal(inferConversation(direction, direction.conversations[1]).status, 'awaiting_self');
  assert.equal(inferConversation(direction, direction.conversations[2]).status, 'unknown');
  const ambiguous = createWorld({scenario: 'ambiguous_resume'});
  const same = inferConversation(ambiguous, ambiguous.conversations[0]);
  assert.equal(same.status, 'unknown');
  assert.match(same.evidence, /时间相同/);
  const missing = inferConversation(ambiguous, ambiguous.conversations[1]);
  assert.equal(missing.status, 'unknown');
  assert.match(missing.evidence, /缺失时间/);
  assert.equal(inferConversation(ambiguous, ambiguous.conversations[2]).status, 'resume_event');
});

test('方向缺失三种模式独占 JD，插件聚合后保留待自己 / 待 Boss / 待确认', () => {
  const world = createWorld({scenario: 'unknown_direction'});
  const jobs = new Map();
  // Match background's verified/unverified contributions for a contact associated with one JD.
  for (const conversation of world.conversations) {
    const {encryptJobId, encryptBossId} = conversation.row;
    if (!encryptJobId) continue;
    const previous = jobs.get(encryptJobId);
    jobs.set(encryptJobId, mergeJob(previous, {
      autoContributions: {...previous?.autoContributions, [encryptBossId]: {
        verified: inferStatus({}, []), unverified: inferConversation(world, conversation)
      }}, conversationIds: [encryptBossId]
    }));
  }
  for (const [index, expected] of [[0, 'awaiting_boss'], [1, 'awaiting_self'], [2, 'unknown']]) {
    const conversation = world.conversations[index];
    const peers = world.conversations.filter(item => item.row.encryptJobId === conversation.row.encryptJobId);
    assert.equal(peers.length, 1, conversation.row.name + ' 必须独占 JD');
    const job = jobs.get(conversation.row.encryptJobId);
    assert.equal(job.status, expected, conversation.row.name);
    assert.equal(Object.keys(job.autoContributions).length, 1);
    assert.deepEqual(job.conversationIds, [conversation.row.encryptBossId]);
  }
});

test('各场景夹具及动作消息 ID 数字区间互不重叠，分页保持数值倒序', () => {
  const seen = new Set(), bossIds = new Set(), jobIds = new Set();
  for (const scenario of Object.keys(SCENARIOS)) {
    const world = createWorld({scenario});
    if (world.conversations.length) appendMessage(world, world.conversations[0].row.encryptBossId, {text: '新增消息'});
    const scenarioJobs = new Set();
    for (const conversation of world.conversations) {
      assert.ok(!bossIds.has(conversation.row.encryptBossId));
      bossIds.add(conversation.row.encryptBossId);
      if (conversation.row.encryptJobId) {
        assert.ok(!jobIds.has(conversation.row.encryptJobId));
        scenarioJobs.add(conversation.row.encryptJobId);
      }
      for (const {mid} of conversation.messages) {
        assert.match(mid, /^\d+$/);
        assert.ok(Number.isSafeInteger(Number(mid)));
        assert.ok(!seen.has(mid), scenario + ': ' + mid);
        seen.add(mid);
      }
      for (let index = 1; index < conversation.messages.length; index++)
        assert.ok(Number(conversation.messages[index].mid) > Number(conversation.messages[index - 1].mid));
      const page = historyPage(conversation, {count: 100});
      assert.deepEqual(page.messages.map(message => message.mid), conversation.messages.map(message => message.mid).reverse());
    }
    for (const jobId of scenarioJobs) jobIds.add(jobId);
  }
});

test('HTTP normal 切换后会话与 JD 独立，旧记录保留且新场景待确认', async context => {
  const client = await clientFor(context);
  for (const [scenario, index, evidence] of [
    ['ambiguous_resume', 1, /缺失时间/],
    ['unknown_direction', 2, /缺少足够状态证据/]
  ]) {
    const conversations = new Map(), normalIds = new Set();
    let normalRow;
    for (const current of ['normal', scenario]) {
      await client.json('/__mock/state', {scenario: current});
      const config = await client.json('/__mock/state');
      const {rows} = await client.json('/__mock/list');
      const row = rows[index], bossId = row.encryptBossId;
      const {zpData} = await client.json('/wapi/zpchat/geek/historyMsg?' + new URLSearchParams({bossId}));
      const saved = conversations.get(bossId) || new Map();
      for (const message of cleanMessages(config, {messages: zpData.messages})) {
        // The plugin merges within a conversation and retains old time/direction for the same ID.
        const old = saved.get(message.id);
        saved.set(message.id, {...old, ...message, time: message.time || old?.time || 0,
          direction: message.direction === 'unknown' && old?.direction ? old.direction : message.direction});
        if (current === 'normal') normalIds.add(message.id);
        else assert.ok(!normalIds.has(message.id));
      }
      conversations.set(bossId, saved);
      const result = inferStatus({lastText: row.lastText, lastIsSelf: row.lastIsSelf, lastMessageAt: row.lastTS}, [...saved.values()]);
      if (current === 'normal') {
        normalRow = row;
        assert.notEqual(result.status, 'unknown');
      } else {
        assert.notEqual(bossId, normalRow.encryptBossId);
        assert.notEqual(row.encryptJobId, normalRow.encryptJobId);
        assert.equal(conversations.size, 2);
        assert.equal(conversations.get(normalRow.encryptBossId).size, normalIds.size);
        assert.equal(saved.size, zpData.messages.length);
        assert.equal(result.status, 'unknown');
        assert.match(result.evidence, evidence);
        assert.equal((await client.request('/wapi/zpchat/geek/historyMsg?bossId=' + normalRow.encryptBossId)).status, 404);
        if (scenario === 'unknown_direction') assert.ok([...saved.values()].every(message => message.direction === 'unknown'));
        else assert.ok([...saved.values()].every(message => !message.time));
      }
    }
  }
});

test('45 条历史以 20/20/5 分页，游标无重复无遗漏', () => {
  const conversation = createWorld({scenario: 'multipage'}).conversations[0];
  const seen = new Set();
  let cursor = '0';
  const sizes = [];
  for (;;) {
    const page = historyPage(conversation, {cursor});
    sizes.push(page.messages.length);
    for (const message of page.messages) {assert.ok(!seen.has(message.mid)); seen.add(message.mid);}
    if (!page.hasMore) break;
    cursor = page.minMsgId;
  }
  assert.deepEqual(sizes, [20, 20, 5]);
  assert.equal(seen.size, 45);
  assert.throws(() => historyPage(conversation, {cursor: 'missing'}), /游标/);
});

test('模拟消息与原插件简历状态识别兼容，消息文本保持原文', () => {
  const world = createWorld();
  const bossId = world.conversations[1].row.encryptBossId;
  const cases = [['apply_resume', 'resume_event'], ['resume', 'resume_event'], ['view_resume', 'resume_event'], ['request_resume', 'resume_requested']];
  for (const [kind, expected] of cases) {
    const message = appendMessage(world, bossId, {kind});
    const result = inferStatus({unread: false}, [{text: message.body.text || message.body.dialog?.content, type: message.type, bodyType: message.body.type, direction: message.from.uid === world.user.userId ? 'out' : 'in', status: message.status, time: message.time}]);
    assert.equal(result.status, expected);
  }
  const future = world.conversations.find(item => item.key === 'resume_rejected');
  const previousTime = future.messages.at(-1).time;
  const added = appendMessage(world, future.row.encryptBossId, {kind: 'unknown_resume'});
  assert.ok(added.time > previousTime);
  assert.equal(inferConversation(world, future).status, 'unknown');
  assert.equal(appendMessage(world, bossId, {text: '<script>alert(1)</script>'}).body.text, '<script>alert(1)</script>');
  assert.throws(() => appendMessage(world, bossId, {text: '  '}), /不能为空/);
  const sent = world.conversations[3].messages.at(-1);
  assert.equal(inferStatus({}, [{text: sent.body.text, type: sent.type, bodyType: sent.body.type}]).status, 'resume_event');
});

test('HTTP 接口真实分页，主动读取不改变未读；打开对话才清零', async context => {
  const client = await clientFor(context);
  await client.json('/__mock/state', {scenario: 'multipage'});
  const initial = await client.json('/__mock/list');
  const bossId = initial.rows[0].encryptBossId;
  let cursor = '0';
  let count = 0;
  for (let page = 1; page <= 3; page++) {
    const result = await client.json('/wapi/zpchat/geek/historyMsg?' + new URLSearchParams({bossId, maxMsgId: cursor, c: '20', page}));
    count += result.zpData.messages.length;
    cursor = result.zpData.minMsgId;
    assert.equal(result.zpData.hasMore, page < 3);
  }
  assert.equal(count, 45);
  assert.equal((await client.json('/__mock/list')).rows[0].unreadCount, initial.rows[0].unreadCount);
  await client.json('/__mock/action', {bossId, kind: 'open'});
  assert.equal((await client.json('/__mock/list')).rows[0].unreadCount, 0);
  assert.equal((await client.json('/__mock/requests')).length, 3);
});

test('场景、账号、会话数据按 cookie 隔离并能重置', async context => {
  const client = await clientFor(context);
  await client.json('/__mock/state', {scenario: 'partial', account: 'beta'});
  assert.equal((await client.json('/__mock/list')).rows.length, 3);
  assert.equal((await client.json('/__mock/list')).ended, false);
  assert.equal((await client.json('/__mock/list?all=1')).rows.length, createWorld().conversations.length);
  const independent = await fetch(client.origin + '/__mock/state').then(response => response.json());
  assert.equal(independent.account, 'alpha');
  assert.equal(independent.scenario, 'normal');
  await client.json('/__mock/state', {scenario: 'empty'});
  assert.deepEqual(await client.json('/__mock/list'), {rows: [], ended: true});
  assert.equal((await client.json('/__mock/state')).account, 'beta');
});

test('HTTP 动作更新历史、列表和职位详情，卡片仅有 dialog', async context => {
  const client = await clientFor(context);
  const initial = await client.json('/__mock/list');
  const bossId = initial.rows[0].encryptBossId;
  for (const [kind, text, type] of [['withdraw', '撤回', 1], ['unknown_resume', '审核', 4], ['resume_failed', '发送失败', 4], ['request_resume', '希望获取', 7]]) {
    const response = await client.json('/__mock/action', {bossId, kind});
    assert.match(response.row.lastText, new RegExp(text));
    const history = await client.json('/wapi/zpchat/geek/historyMsg?' + new URLSearchParams({bossId, maxMsgId: '0'}));
    const message = history.zpData.messages[0];
    assert.equal(message.body.type, type);
    assert.match(message.body.text || message.body.dialog?.content, new RegExp(text));
    if (kind === 'request_resume') assert.equal(message.body.text, '');
  }
  const changed = await client.json('/__mock/action', {bossId, kind: 'switch_job'});
  assert.equal(changed.row.encryptJobId, initial.rows[1].encryptJobId);
  assert.equal((await client.json('/__mock/list')).rows[0].jobName, initial.rows[1].jobName);
  const detail = await client.json('/wapi/zpchat/geek/getBossData?' + new URLSearchParams({bossId}));
  assert.equal(detail.zpData.data.encryptJobId, initial.rows[1].encryptJobId);
  assert.equal(detail.zpData.job.jobName, initial.rows[1].jobName);
  assert.equal((await client.request('/__mock/action', {bossId: initial.rows[2].encryptBossId, kind: 'switch_job'})).status, 400);
  await client.json('/__mock/state', {scenario: 'unknown_direction'});
  await client.json('/__mock/action', {bossId: (await client.json('/__mock/list')).rows[0].encryptBossId, kind: 'read'});
});

test('可重现 HTTP、非 JSON、业务异常及游标停滞', async context => {
  const client = await clientFor(context);
  let history;
  async function scenarioHistory(scenario) {
    await client.json('/__mock/state', {scenario});
    history = '/wapi/zpchat/geek/historyMsg?bossId=alpha-' + scenario + '-boss-1&maxMsgId=0&page=1';
  }
  for (const [scenario, status] of [['unauthorized', 401], ['forbidden', 403], ['server_error', 500]]) {
    await scenarioHistory(scenario);
    assert.equal((await client.request(history)).status, status);
  }
  await scenarioHistory('rate_limit');
  assert.equal((await client.request(history)).status, 200);
  const limited = await client.request(history.replace('page=1', 'page=2'));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '600');
  await scenarioHistory('invalid_json');
  assert.match((await client.request(history)).headers.get('content-type'), /text\/html/);
  await scenarioHistory('business_error');
  assert.equal((await client.json(history)).code, 37);
  await scenarioHistory('malformed');
  assert.equal((await client.json(history)).zpData.messages, 'invalid');
  await scenarioHistory('stalled');
  const first = (await client.json(history)).zpData;
  const second = (await client.json(history.replace('maxMsgId=0', 'maxMsgId=' + first.minMsgId))).zpData;
  assert.equal(second.minMsgId, first.minMsgId);
});

test('静态页面、职位路径、错误输入及跨源写入', async context => {
  const client = await clientFor(context);
  for (const path of ['/web/geek/chat', '/web/geek/jobs', '/job_detail/alpha-normal-job-frontend.html', '/job_detail/alpha-ambiguous_resume-job-fullstack.html', '/gongsi/job/mock-company~.html?ka=company-jobs']) assert.equal((await client.request(path)).status, 200);
  const html = await (await client.request('/web/geek/chat')).text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
  assert.ok(assets.some(path => path.endsWith('.js')));
  assert.ok(assets.some(path => path.endsWith('.css')));
  for (const path of assets) assert.equal((await client.request(path)).status, 200);
  assert.equal((await client.request('/not-found')).status, 404);
  assert.equal((await client.request('/__mock/state', {scenario: 'missing'})).status, 400);
  assert.equal((await client.request('/wapi/zpchat/geek/historyMsg?bossId=alpha-normal-boss-1&c=-1')).status, 400);
  const forbidden = await fetch(client.origin + '/__mock/state', {method: 'POST', headers: {origin: 'https://example.com'}, body: '{}'});
  assert.equal(forbidden.status, 403);
});

test('单一扩展同时支持真实站点与本地 mock，mock 账号使用专用命名空间', async () => {
  const extension = new URL('../../extension/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', extension), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://www.zhipin.com/*', 'http://127.0.0.1:4173/*', 'http://localhost:4173/*']);
  assert.ok(manifest.content_scripts.every(script => ['https://www.zhipin.com/web/*', 'http://127.0.0.1:4173/web/*'].every(pattern => script.matches.includes(pattern))));
  assert.ok(manifest.content_scripts.every(script => ['https://www.zhipin.com', 'http://127.0.0.1:4173', 'http://localhost:4173'].every(origin => script.matches.includes(origin + '/gongsi/job/*.html*'))));
  const main = await readFile(new URL('src/main.ts', extension), 'utf8');
  assert.match(main, /const MOCK_ORIGIN='http:\/\/127\.0\.0\.1:4173';/);
  assert.match(main, /isMock\?'boss:mock:':'boss:'/);
  const background = await readFile(new URL('src/background.ts', extension), 'utf8');
  assert.match(background, /SITE_ORIGINS=\['https:\/\/www\.zhipin\.com','http:\/\/127\.0\.0\.1:4173','http:\/\/localhost:4173'\]/);
  assert.match(background, /SITE_ORIGINS\.map\(origin=>origin\+'\/web\/geek\/chat\*'\)/);
});
