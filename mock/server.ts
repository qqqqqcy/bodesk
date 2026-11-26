import http, {type IncomingMessage, type ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ACCOUNTS, SCENARIOS, createWorld, listRows, jobPageFixtures, historyPage, appendMessage, switchJob} from './fixtures.ts';
import type {Connect} from 'vite';
import {isCompanyJobsPath} from '../extension/src/company-jobs.ts';

const PUBLIC = resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const MIME: Record<string, string> = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json'};
const sessionWorld=(options?: Parameters<typeof createWorld>[0])=>{
  const world=createWorld(options);
  return {...world,favoriteCompanies:world.scenario==='empty'?[]:['星河科技','仅收藏的示例公司'],deletionProbe:randomUUID().replaceAll('-','').slice(0,12)};
};

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers});
  response.end(JSON.stringify(value));
}

async function bodyOf(request: IncomingMessage) {
  let content = '';
  for await (const chunk of request) {
    content += chunk;
    if (content.length > 16384) throw new Error('请求过大');
  }
  return JSON.parse(content || '{}');
}

export function createMockServer({webMiddleware}: {webMiddleware?: Connect.NextHandleFunction} = {}) {
  const sessions = new Map<string, ReturnType<typeof sessionWorld>>();
  return http.createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    const url = new URL(request.url || '/', 'http://localhost');
    if (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host) return json(response, 403, {error: '仅接受同源请求'});
    const cookieName = 'boss_mock';
    let sessionId = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!sessionId || !sessions.has(sessionId)) {
      sessionId = randomUUID();
      sessions.set(sessionId, sessionWorld());
      response.setHeader('set-cookie', cookieName + '=' + sessionId + '; HttpOnly; SameSite=Strict; Path=/');
    }
    const world = sessions.get(sessionId)!;
    const ok = (value: unknown) => json(response, 200, value);
    try {
      if (url.pathname === '/__mock/state' && request.method === 'POST') {
        const options = await bodyOf(request);
        const replacement = sessionWorld({scenario: options.scenario ?? world.scenario, account: options.account ?? world.account});
        sessions.set(sessionId, replacement);
        return ok({ok: true});
      }
      if (url.pathname === '/__mock/state' && request.method === 'GET') return ok({scenario: world.scenario, account: world.account, user: world.user, scenarios: SCENARIOS, accounts: ACCOUNTS, count: world.conversations.length});
      if (url.pathname === '/__mock/requests' && request.method === 'GET') return ok(world.requests);
      if (url.pathname === '/__mock/jobs' && request.method === 'GET') return ok(jobPageFixtures(world));
      if (url.pathname === '/__mock/favorites' && request.method === 'GET') return ok({rows:jobPageFixtures(world).rows.filter(row=>world.favoriteJobIds.includes(row.encryptJobId))});
      if (url.pathname === '/__mock/company-favorites' && request.method === 'GET') return ok({names:world.favoriteCompanies});
      if (url.pathname === '/__mock/company-favorites' && request.method === 'POST') {
        const {companyName,favorite}=await bodyOf(request);
        if(typeof companyName!=='string'||!companyName.trim()||typeof favorite!=='boolean')throw new Error('无效公司收藏操作');
        world.favoriteCompanies=world.favoriteCompanies.filter(name=>name!==companyName);
        if(favorite)world.favoriteCompanies.push(companyName);
        return ok({ok:true});
      }
      if (url.pathname === '/__mock/favorite' && request.method === 'POST') {
        const action=await bodyOf(request);
        if(typeof action.favorite!=='boolean'||!jobPageFixtures(world).rows.some(row=>row.encryptJobId===action.jobId))throw new Error('无效收藏操作');
        world.favoriteJobIds=world.favoriteJobIds.filter(id=>id!==action.jobId);
        if(action.favorite)world.favoriteJobIds.push(action.jobId);
        return ok({ok:true});
      }
      if (url.pathname === '/__mock/list' && request.method === 'GET') {
        const limit = url.searchParams.get('all') === '1' || world.scenario !== 'partial' ? Infinity : 3;
        return ok({rows: listRows(world, limit), ended: limit >= world.conversations.length});
      }
      if (url.pathname === '/__mock/action' && request.method === 'POST') {
        const action = await bodyOf(request);
        const conversation = world.conversations.find(item => item.row.encryptBossId === action.bossId);
        if (!conversation) return json(response, 404, {error: '联系人不存在'});
        if (action.kind === 'open') conversation.row.unreadCount = 0;
        else if (action.kind === 'read') {
          for (const message of conversation.messages) if (message.from?.uid === world.user.userId) message.status = 2;
          if (conversation.row.lastIsSelf) conversation.row.lastMsgStatus = 2;
        } else if (action.kind === 'switch_job') switchJob(world, action.bossId);
        else appendMessage(world, action.bossId, action);
        return ok({ok: true, row: conversation.row});
      }
      if (url.pathname.startsWith('/wapi/')) {
        if (request.method !== 'GET') return json(response, 405, {error: '此接口只支持 GET'});
        const isHistory = url.pathname === '/wapi/zpchat/geek/historyMsg';
        if (!isHistory && url.pathname !== '/wapi/zpchat/geek/getBossData') return json(response, 404, {code: 404});
        const entry = {path: url.pathname, bossId: url.searchParams.get('bossId'), cursor: url.searchParams.get('maxMsgId'), page: url.searchParams.get('page'), at: Date.now(), status: 200};
        world.requests.push(entry);
        if (world.requests.length > 300) world.requests.shift();
        const fail = (status: number, value: unknown, headers?: Record<string, string>) => {entry.status = status; return json(response, status, value, headers);};
        if (world.scenario === 'unauthorized') return fail(401, {code: 1, message: 'mock 登录已失效'});
        if (world.scenario === 'forbidden') return fail(403, {code: 37, message: 'mock 需要验证'});
        const conversation = world.conversations.find(item => item.row.encryptBossId === entry.bossId);
        if (!conversation) return fail(404, {code: 404, message: '联系人不存在'});
        if (world.scenario === 'slow') await new Promise<void>(resolveWait => {
          const timer = setTimeout(resolveWait, 16000);
          response.once('close', () => {clearTimeout(timer); resolveWait();});
        });
        if (response.destroyed) return;
        if (isHistory) {
          if (world.scenario === 'rate_limit' && Number(entry.page) >= 2) return fail(429, {code: 429}, {'retry-after': '600'});
          if (world.scenario === 'server_error') return fail(500, {code: 500});
          if (world.scenario === 'invalid_json') {
            response.writeHead(200, {'content-type': 'text/html'});
            return response.end('<h1>Mock 安全验证</h1>');
          }
          if (world.scenario === 'business_error') return ok({code: 37, message: 'Mock 业务拒绝'});
          if (world.scenario === 'malformed') return ok({code: 0, zpData: {messages: 'invalid', hasMore: true}});
          const count = Number(url.searchParams.get('c') ?? 20);
          if (!Number.isInteger(count) || count < 1 || count > 100) return fail(400, {code: 400, message: 'c 应为 1–100'});
          return ok({code: 0, zpData: historyPage(conversation, {cursor: entry.cursor ?? '0', count, stalled: world.scenario === 'stalled'})});
        }
        return ok({code: 0, zpData: conversation.detail});
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, {error: '不支持此方法'});
      if (webMiddleware) return webMiddleware(request, response, () => json(response, 404, {error: '页面不存在'}));
      const page = ['/', '/web/geek/chat', '/web/geek/jobs', '/web/geek/recommend'].includes(url.pathname) || /^\/job_detail\/[a-z0-9_-]+\.html$/.test(url.pathname) || isCompanyJobsPath(url.pathname);
      if (!page && !url.pathname.startsWith('/assets/')) return json(response, 404, {error: '页面不存在'});
      const file = page ? resolve(PUBLIC, 'index.html') : resolve(PUBLIC, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(PUBLIC + sep)) return json(response, 404, {error: '页面不存在'});
      const mime = MIME[extname(file)] || 'application/octet-stream';
      let content: Buffer;
      try {content = await readFile(file);} catch {return json(response, 404, {error: '构建文件不存在，请先运行 npm run build'});}
      response.writeHead(200, {'content-type': mime + '; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'"});
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!response.headersSent) json(response, 400, {error: error instanceof Error ? error.message : '模拟服务错误'});
      else response.end();
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 4173);
  const server = createMockServer();
  server.listen(port, '127.0.0.1', () => console.log('Mock BOSS: http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port + '/web/geek/chat'));
}
