// Run from the project root: npm run research:export
// A deliberately limited prototype: exports the first already-read conversation's
// first history page. It refuses to open an unread conversation.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

async function exportSample(outputDir) {
const fs = await import('node:fs/promises');
const path = await import('node:path');
const spaces = await listTaskSpaces();
const matches = spaces.filter(s => s.profileName === '爬虫');
if (matches.length !== 1) throw new Error('无法唯一找到「爬虫」空间');
const entry = matches[0];
if (entry.ownership !== 'agent' && entry.ownership !== 'user') throw new Error('空间控制权不可用');
const task = entry.ownership === 'user' ? await claimTaskSpace(entry.id) : await taskSpace(entry.id);
const tabs = await task.tabs();
const candidates = tabs.filter(x => x.url.startsWith('https://www.zhipin.com/web/geek/chat'));
const tab = candidates.find(x => x.active) || candidates[candidates.length - 1];
if (!tab) throw new Error('请在「爬虫」空间打开 BOSS 聊天页');
const page = tab.label ? task.page(tab.label) : await task.adopt(tab.page);
await page.cdp('Network.enable');
await page.reload({timeout: 30000});
await page.waitForSelector('[role=listitem]', {timeout: 15000});
const state = await page.evaluate(() => {
  const first = document.querySelector('[role=listitem]');
  return {count: document.querySelectorAll('[role=listitem]').length, unread: !!first?.querySelector('.notice-badge')};
});
if (!state.count || state.unread) throw new Error('首个会话不存在或未读，已停止，未打开会话');
await page.events();
const started = Date.now();
await page.click('loc=css:[role=listitem] >> nth=0');
await page.waitForSelector('.message-item', {timeout: 15000});
const events = await page.events();
const request = events.find(e => e.method === 'Network.requestWillBeSent' && new URL(e.params.request.url).pathname === '/wapi/zpchat/geek/historyMsg');
if (!request) throw new Error('未捕获历史请求，请重试；没有写出文件');
const response = JSON.parse((await page.cdp('Network.getResponseBody', {requestId: request.params.requestId})).body);
if (response.code !== 0 || !Array.isArray(response.zpData?.messages)) throw new Error('历史接口没有返回预期数据，未写出文件');
// securityId is an access-related identifier; do not persist it or request URLs.
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/^(securityId|cookie|token|authorization)$/i.test(k)).map(([k,v]) => [k,scrub(v)]));
  return value;
}
const result = {exportedAt: new Date().toISOString(), scope: 'first read conversation, first history page only', serverReportsEnd: response.zpData.hasMore === false, hasMore: response.zpData.hasMore, messageCount: response.zpData.messages.length, elapsedMs: Date.now() - started, messages: scrub(response.zpData.messages)};
await fs.mkdir(outputDir, {recursive: true, mode: 0o700});
const filename = path.join(outputDir, `sample-${Date.now()}.json`);
await fs.writeFile(filename, JSON.stringify(result, null, 2), {flag:'wx', mode:0o600});
console.log({file:filename, messageCount:result.messageCount, hasMore:result.hasMore, elapsedMs:result.elapsedMs});
await task.finish({keep:[page.label]});
}

// ego scripts do not inherit the shell cwd or environment; pass the absolute path as data.
const outputDir = fileURLToPath(new URL('../../private-exports/', import.meta.url));
const script = '(' + exportSample.toString() + ')(' + JSON.stringify(outputDir) + ')';
const result = spawnSync('ego-browser', ['nodejs', '-e', script], {stdio: 'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;