import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createWorld} from '../mock/fixtures.ts';
import {createMockServer} from '../mock/server.ts';

const artifacts = new URL('../artifacts/', import.meta.url);
await mkdir(artifacts, {recursive: true});
const server = process.env.MOCK_ORIGIN ? null : createMockServer();
if (server) await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
const origin = process.env.MOCK_ORIGIN ?? 'http://127.0.0.1:' + server.address().port;
const main = (await readFile(new URL('../extension/dist/main.js', import.meta.url), 'utf8'))
  .replace(/const MOCK_ORIGIN\s*=\s*["']http:\/\/127\.0\.0\.1:4173["'];/, 'const MOCK_ORIGIN=' + JSON.stringify(origin) + ';');
const settings = {
  origin, main, content: await readFile(new URL('../extension/dist/content.js', import.meta.url), 'utf8'), spaceName: 'Mock BOSS 覆盖验证 ' + Date.now(),
  core: (await readFile(new URL('../extension/dist/core.js', import.meta.url), 'utf8')).replace(/^export\s*\{[^}]+\};?$/gm, '') + '\nwindow.__smokeInferStatus = inferStatus; window.__smokeMergeJob = mergeJob;',
  contactCount: createWorld().conversations.length,
  starCount: createWorld().conversations.filter(item => item.row.brandName === '星河科技').length,
  mockAccount: createHash('sha256').update('boss:mock:mock-geek-beta').digest('hex').slice(0, 24),
  screenshot: fileURLToPath(new URL('desktop.png', artifacts)),
  mobileScreenshot: fileURLToPath(new URL('mobile.png', artifacts))
};

async function smoke(config) {
  const task = await taskSpace(config.spaceName);
  const page = (await task.pages())[0] ?? await task.adopt((await task.tabs())[0].page);
  await page.goto(config.origin + '/web/geek/chat');
  await page.waitForFunction(() => document.querySelector('#scenario').options.length > 0);
  await page.fetch('/__mock/state', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({scenario: 'normal', account: 'alpha'})});
  await page.reload();
  await page.waitForFunction(count => document.querySelectorAll('.contact').length === count, config.contactCount);
  await page.click("button[data-boss-id='alpha-normal-boss-2']");
  await page.waitForFunction(() => document.querySelectorAll('.message-item').length === 4);
  await page.fill('#draft', '<script>window.unwanted = true</script> 本地消息');
  await page.click("loc=role:button[name='发送消息']");
  await page.waitForFunction(() => document.querySelectorAll('.message-item').length === 5);
  if (!await page.evaluate(() => !window.unwanted && document.querySelector('.bubble script') === null)) throw new Error('消息被作为 HTML 执行');
  await page.click("button[data-action='resume']");
  await page.waitForFunction(() => document.querySelectorAll('.message-item').length === 6);
  await page.click("button[data-action='read']");
  await page.waitForFunction(() => [...document.querySelectorAll('.message.out .message-meta')].every(item => item.textContent.includes('已读')));
  await page.fill('#search', '星河');
  await page.waitForFunction(count => document.querySelectorAll('.contact').length === count, config.starCount);
  await page.fill('#search', '');
  await page.selectOption('#scenario', 'partial');
  await page.waitForFunction(() => document.querySelectorAll('.contact').length === 3 && !document.querySelector('#load-contacts').hidden);
  await page.click('#load-contacts');
  await page.waitForFunction(count => document.querySelectorAll('.contact').length === count, config.contactCount);
  await page.selectOption('#scenario', 'empty');
  await page.waitForFunction(() => document.querySelectorAll('.contact').length === 0);
  await page.selectOption('#account', 'beta');
  await page.waitForFunction(() => window._PAGE?.uid === 'mock-geek-beta');
  await page.selectOption('#scenario', 'multipage');
  await page.waitForSelector("button[data-boss-id='beta-multipage-boss-1']");
  await page.click("button[data-boss-id='beta-multipage-boss-1']");
  await page.waitForFunction(() => document.querySelectorAll('.message-item').length === 20);
  await page.click('#older');
  await page.waitForFunction(() => document.querySelectorAll('.message-item').length === 40);
  await page.click('#older');
  await page.waitForFunction(() => document.querySelectorAll('.message-item').length === 45 && document.querySelector('#older').hidden);
  await page.click('#current-job');
  await page.waitForURL('**/job_detail/beta-multipage-job-frontend.html');
  await page.waitForFunction(() => document.querySelector('.job-banner h1').textContent === '前端工程师');
  await page.goto(config.origin + '/web/geek/chat');
  await page.waitForSelector("button[data-boss-id='beta-multipage-boss-1']");
  await page.evaluate(() => {
    window.__smokeAccounts = [];
    window.addEventListener('message', event => {
      if (event.source === window && event.origin === location.origin && event.data?.channel === 'boss-local-helper-v1' && event.data.direction === 'to-extension' && event.data.data?.account) window.__smokeAccounts.push(event.data.data.account);
    });
  });
  await page.evaluate(config.main);
  await page.waitForFunction(() => document.querySelector('#bridge-log').textContent.includes('SNAPSHOT'));
  await page.waitForFunction(account => window.__smokeAccounts.includes(account), config.mockAccount);
  await page.click("button[data-boss-id='beta-multipage-boss-1']");
  await page.waitForFunction(() => document.querySelector('#bridge-log').textContent.includes('CONVERSATION'));
  await page.selectOption('#scenario', 'normal');
  await page.waitForSelector("button[data-boss-id='beta-normal-boss-13']");
  await page.evaluate(() => {
    window.__smokeEvents = [];
    window.addEventListener('message', event => {
      if (event.source === window && event.origin === location.origin && event.data?.channel === 'boss-local-helper-v1' && event.data.direction === 'to-extension') window.__smokeEvents.push(event.data.data);
    });
  });
  await page.evaluate(config.main);
  await page.evaluate(() => {
    // Run the unmodified content script with a local-only stand-in for its background responses.
    window.chrome = window.chrome || {};
    window.chrome.runtime = {onMessage: {addListener() {}}, sendMessage: async message => message.type === 'WIDGET_GET'
      ? {ok: true, data: {companyId: 'mock', companyName: message.companyName, jobs: [{id: 'mock-job', title: message.title, status: 'unknown'}]}}
      : {ok: true}};
  });
  await page.evaluate(config.content);
  await page.waitForFunction(() => window.__smokeEvents.some(event => event.type === 'SNAPSHOT' && event.rows.some(row => row.name.includes('__xss'))));
  await page.click("button[data-boss-id='beta-normal-boss-13']");
  await page.waitForFunction(() => document.querySelector('#contact-name').textContent.includes('__xss') && document.querySelector('.bh-job-title')?.textContent.includes('__xss'));
  if (!await page.evaluate(() => !window.__xss && !document.querySelector('#contact-list script, #contact-name script, #current-job script, #boss-local-helper-widget script'))) throw new Error('姓名或职位被作为 HTML 执行');
  await page.click("button[data-boss-id='beta-normal-boss-12']");
  await page.waitForFunction(() => [...document.querySelectorAll('.bubble')].some(item => item.textContent.includes('希望获取您的附件简历')));
  await page.waitForFunction(() => window.__smokeEvents.some(event => event.type === 'SNAPSHOT' && event.selectedId === 'beta-normal-boss-12' && event.liveMessages.some(message => message.text.includes('希望获取您的附件简历'))));
  await page.click("button[data-action='unknown_resume']");
  await page.waitForFunction(() => window.__smokeEvents.some(event => event.type === 'SNAPSHOT' && event.liveMessages.some(message => message.text.includes('正在审核') && message.isSystem)));
  await page.click("button[data-boss-id='beta-normal-boss-1']");
  await page.click("button[data-action='switch_job']");
  await page.waitForFunction(() => document.querySelector('#current-job').textContent.includes('全栈工程师'));
  await page.waitForFunction(() => window.__smokeEvents.some(event => event.type === 'SNAPSHOT' && event.rows.some(row => row.id === 'beta-normal-boss-1' && row.jobId === 'beta-normal-job-fullstack')));
  if (!await page.evaluate(() => !window.__xss)) throw new Error('插件观察或页面渲染执行了脚本');
  console.log({pass: ['发送消息与文本转义', '姓名与职位安全文本及插件快照', 'dialog 卡片', '系统消息快照', '切换 JD 快照', '简历与已读操作', '搜索', '加载剩余联系人', '空账号', '账号切换', '20/20/5 分页', '职位上下文', '源扩展 MAIN 页面观察与 mock 账号隔离'], taskSpaceId: task.spaceId});
  await page.click("button[data-boss-id='beta-normal-boss-2']");
  await page.waitForFunction(() => document.querySelectorAll('.message-item').length === 4);
  await page.screenshot({path: config.screenshot, fullPage: true});
  await page.cdp('Emulation.setDeviceMetricsOverride', {width: 320, height: 800, deviceScaleFactor: 1, mobile: true});
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  if (!fits) throw new Error('320px 窄屏存在水平溢出');
  await page.screenshot({path: config.mobileScreenshot, fullPage: true});
  await page.cdp('Emulation.clearDeviceMetricsOverride');
  console.log({desktopScreenshot: config.screenshot, mobileScreenshot: config.mobileScreenshot, mobileWidth: 320, horizontalOverflow: false});
  for (const [scenario, index, evidence] of [
    ['ambiguous_resume', 2, '缺失时间'],
    ['unknown_direction', 3, '缺少足够状态证据']
  ]) {
    let previous = {bossId: '', jobId: '', messages: []};
    for (const current of ['normal', scenario]) {
      const bossId = 'beta-' + current + '-boss-' + index + (current === 'unknown_direction' ? '-direction' : '');
      await page.selectOption('#scenario', current);
      await page.waitForSelector("button[data-boss-id='" + bossId + "']");
      await page.click("button[data-boss-id='" + bossId + "']");
      await page.waitForFunction(() => document.querySelectorAll('.message-item').length > 0);
      await page.evaluate(config.core);
      const result = await page.evaluate(({previous, bossId}) => {
        const row = document.querySelector('#contact-list').__vue__.fullList.find(item => item.encryptBossId === bossId);
        const messages = [...document.querySelectorAll('.message-item')].map(element => {
          const message = element.__vue__.$props.message;
          return {id: message.mid, time: message.time || 0, type: message.type, bodyType: message.bodyType,
            isSystem: element.classList.contains('item-system'), text: message.text || message.dialog?.content || '',
            direction: typeof message.isSelf === 'boolean' ? message.isSelf ? 'out' : 'in' : 'unknown'};
        });
        const saved = new Map((previous.bossId === bossId ? previous.messages : []).map(message => [message.id, message]));
        for (const message of messages) {
          const old = saved.get(message.id);
          saved.set(message.id, {...old, ...message, time: message.time || old?.time || 0,
            direction: message.direction === 'unknown' && old?.direction ? old.direction : message.direction});
        }
        return {bossId, jobId: row.encryptJobId, messages, inferred: window.__smokeInferStatus({lastText: row.lastText, lastIsSelf: row.lastIsSelf, lastMessageAt: row.lastTS}, [...saved.values()])};
      }, {previous, bossId});
      if (current === 'normal') previous = result;
      else {
        if (result.bossId === previous.bossId || result.jobId === previous.jobId) throw new Error('跨场景会话或 JD ID 重叠');
        if (result.messages.some(message => previous.messages.some(old => old.id === message.id))) throw new Error('跨场景消息 ID 重叠');
        if (result.inferred.status !== 'unknown' || !result.inferred.evidence.includes(evidence)) throw new Error('场景切换未触发预期待确认：' + JSON.stringify(result.inferred));
      }
    }
  }
  console.log({pass: ['normal → ambiguous_resume 缺失时间待确认', 'normal → unknown_direction 方向缺失待确认', '会话 / JD / 消息 ID 跨场景无重叠']});
  await page.evaluate(async () => {
    const {rows} = await fetch('/__mock/list').then(response => response.json());
    const config = await fetch('/__mock/state').then(response => response.json());
    const jobs = new Map();
    for (const row of rows) {
      if (!row.encryptJobId) continue;
      const {zpData} = await fetch('/wapi/zpchat/geek/historyMsg?' + new URLSearchParams({bossId: row.encryptBossId})).then(response => response.json());
      const messages = zpData.messages.map(message => ({time: message.time || 0, type: message.type, bodyType: message.body.type,
        isSystem: message.body.type === 4 ? true : null, text: message.body.text || message.body.dialog?.content || '',
        direction: message.from?.uid === config.user.userId ? 'out' : message.to?.uid === config.user.userId ? 'in' : 'unknown'}));
      const previous = jobs.get(row.encryptJobId);
      jobs.set(row.encryptJobId, window.__smokeMergeJob(previous, {id: row.encryptJobId, title: row.jobName, companyName: row.brandName,
        autoContributions: {...previous?.autoContributions, [row.encryptBossId]: {verified: window.__smokeInferStatus({}, []),
          unverified: window.__smokeInferStatus({lastText: row.lastText, lastIsSelf: row.lastIsSelf, lastMessageAt: row.lastTS}, messages)}},
        conversationIds: [row.encryptBossId]}));
    }
    window.chrome = window.chrome || {};
    window.chrome.runtime = {onMessage: {addListener() {}}, sendMessage: async message => message.type === 'WIDGET_GET'
      ? {ok: true, data: {companyId: message.companyName, companyName: message.companyName,
        jobs: [...jobs.values()].filter(job => job.companyName === message.companyName).map(job => ({...job, current: job.id === message.jobId}))}}
      : {ok: true}};
  });
  await page.evaluate(config.content);
  await page.evaluate(config.main);
  for (const [index, label] of [[1, '待 Boss 回复'], [2, '待自己回复'], [3, '待确认']]) {
    await page.click("button[data-boss-id='beta-unknown_direction-boss-" + index + "-direction']");
    await page.waitForFunction(label => document.querySelector('.bh-current .bh-job-status')?.textContent === label, label);
  }
  console.log({pass: ['源插件 mergeJob 聚合并在浮窗显示：林沐待 Boss 回复、周然待自己回复、何悦待确认']});
}

function browser(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('ego-browser', ['nodejs', '-e', script], {stdio: 'inherit'});
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}
try {
  const status = await browser('(' + smoke.toString() + ')(' + JSON.stringify(settings) + ')');
  process.exitCode = status;
  if (status === 0) process.exitCode = await browser('const task = await taskSpace(' + JSON.stringify(settings.spaceName) + '); await task.finish({keep:[]});');
} finally {
  if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
}
