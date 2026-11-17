const element = id => document.getElementById(id);
const state = {rows: [], selected: null, messages: [], cursor: '0', page: 0, hasMore: false, revision: 0, bridge: []};
const listVue = {$options: {name: 'boss-list'}, fullList: [], isLoading: true, bottomText: ''};
element('contact-list').__vue__ = listVue;
const recordVue = {boss: {encryptBossId: null}};
document.querySelector('.chat-record').__vue__ = recordVue;

function notice(message = '') {
  element('notice').textContent = message;
  element('notice').hidden = !message;
}

async function api(path, data) {
  const response = await fetch(path, data === undefined ? undefined : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(data)});
  if (!response.ok) throw new Error('模拟接口 HTTP ' + response.status);
  const result = await response.json();
  if (result.error) throw new Error(result.error);
  return result;
}

function run(operation) {
  return operation().catch(error => notice(error.message));
}

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function fillSelect(id, entries, selected) {
  const select = element(id);
  for (const [value, description] of Object.entries(entries)) {
    const option = node('option', '', typeof description === 'string' ? description : description.label);
    option.value = value;
    select.append(option);
  }
  select.value = selected;
  select.addEventListener('change', () => run(() => reset()));
}

async function reset() {
  await api('/__mock/state', {scenario: element('scenario').value, account: element('account').value});
  location.assign(location.pathname === '/web/geek/jobs' ? '/web/geek/jobs' : '/web/geek/chat');
}

function renderContacts() {
  const query = element('search').value.toLowerCase();
  const fragment = document.createDocumentFragment();
  for (const row of state.rows.filter(item => [item.name, item.brandName, item.jobName].join(' ').toLowerCase().includes(query))) {
    const button = node('button', 'contact' + (row.encryptBossId === state.selected ? ' selected' : ''));
    button.dataset.bossId = row.encryptBossId;
    button.type = 'button';
    button.setAttribute('aria-label', row.name + '，' + row.brandName + '，' + row.jobName);
    button.setAttribute('aria-pressed', String(row.encryptBossId === state.selected));
    const content = node('div', 'contact-content');
    const top = node('div', 'contact-top');
    top.append(node('strong', '', row.name));
    if (row.unreadCount > 0) top.append(node('span', 'unread', row.unreadCount));
    content.append(top, node('div', 'contact-job', row.brandName + ' · ' + row.jobName), node('div', 'contact-preview', row.lastText));
    button.append(node('span', 'avatar', row.name.slice(0, 1)), content);
    button.addEventListener('click', () => run(() => openConversation(row.encryptBossId)));
    fragment.append(button);
  }
  if (!fragment.childNodes.length) fragment.append(node('p', 'list-end', query ? '没有匹配的联系人' : '暂无沟通记录'));
  element('contact-list').replaceChildren(fragment);
  element('contact-count').textContent = state.rows.length + ' 位联系人';
}

async function loadContacts(all = false) {
  const result = await api('/__mock/list' + (all ? '?all=1' : ''));
  state.rows = result.rows;
  Object.assign(listVue, {fullList: state.rows, isLoading: false, bottomText: result.ended ? '没有更多了' : '加载更多'});
  element('load-contacts').hidden = result.ended;
  element('list-end').textContent = result.ended ? '没有更多了' : '当前仅加载部分联系人';
  renderContacts();
}

async function openConversation(bossId) {
  const revision = ++state.revision;
  state.selected = bossId;
  state.messages = [];
  state.cursor = '0';
  state.page = 0;
  state.hasMore = false;
  recordVue.boss = {encryptBossId: bossId};
  notice();
  element('messages').replaceChildren();
  element('older').hidden = true;
  element('draft').value = '';
  element('chat-empty').hidden = true;
  element('chat-active').hidden = false;
  const row = state.rows.find(item => item.encryptBossId === bossId);
  element('contact-name').textContent = row.name;
  element('contact-company').textContent = row.brandName + ' · 招聘负责人';
  element('current-job').textContent = row.jobName + (row.encryptJobId ? '　查看职位详情 →' : '　· 暂无可验证 JD');
  element('current-job').href = row.encryptJobId ? '/job_detail/' + row.encryptJobId + '.html' : '#';
  renderContacts();
  const opened = await api('/__mock/action', {bossId, kind: 'open'});
  if (revision !== state.revision) return;
  Object.assign(row, opened.row);
  renderContacts();
  await loadHistory(revision);
}

async function loadHistory(revision = state.revision) {
  const bossId = state.selected;
  const params = new URLSearchParams({bossId, securityId: 'synthetic-local-only', maxMsgId: state.cursor, c: '20', page: String(state.page + 1), src: '0'});
  const result = await api('/wapi/zpchat/geek/historyMsg?' + params);
  if (revision !== state.revision) return;
  if (result.code !== 0) throw new Error('模拟接口 code=' + result.code);
  const data = result.zpData;
  if (!Array.isArray(data?.messages) || typeof data.hasMore !== 'boolean') throw new Error('模拟历史响应结构异常');
  const merged = new Map([...state.messages, ...data.messages].map(message => [message.mid, message]));
  state.messages = [...merged.values()].sort((first, second) => first.time - second.time);
  state.hasMore = data.hasMore;
  if (state.hasMore && state.page > 0 && data.minMsgId === state.cursor) {
    state.hasMore = false;
    notice('检测到模拟游标停滞；已保留加载的消息。');
  }
  state.cursor = data.minMsgId;
  state.page++;
  renderMessages();
}

function renderMessages() {
  const row = state.rows.find(item => item.encryptBossId === state.selected);
  const fragment = document.createDocumentFragment();
  for (const message of state.messages) {
    const isSelf = message.from?.uid === state.config.user.userId ? true : message.to?.uid === state.config.user.userId ? false : null;
    const isSystem = message.body.type === 4;
    const container = node('article', 'message message-item ' + (isSelf ? 'out' : 'in') + (isSystem ? ' item-system' : ''));
    container.dataset.messageId = message.mid;
    container.__vue__ = {$props: {message: {mid: message.mid, time: message.time, type: message.type, bodyType: message.body.type, isSystem, isSelf, status: message.status, text: message.body.text, dialog: message.body.dialog}}};
    const body = node('div', 'message-body');
    const content = message.body.text || message.body.dialog?.content || '';
    const time = message.time ? new Date(message.time).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'}) : '时间未知';
    body.append(node('div', 'bubble', content), node('div', 'message-meta', time + (isSelf ? message.status === 2 ? ' · 已读' : ' · 已送达' : '')));
    container.append(node('span', 'avatar', isSelf ? '我' : row.name.slice(0, 1)), body);
    fragment.append(container);
  }
  element('messages').replaceChildren(fragment);
  element('older').hidden = !state.hasMore;
}

async function performAction(kind, text) {
  if (!state.selected) return;
  const revision = state.revision;
  const result = await api('/__mock/action', {bossId: state.selected, kind, text});
  if (revision !== state.revision) return;
  Object.assign(state.rows.find(item => item.encryptBossId === state.selected), result.row);
  if (kind === 'switch_job') {
    element('current-job').textContent = result.row.jobName + '　查看职位详情 →';
    element('current-job').href = '/job_detail/' + result.row.encryptJobId + '.html';
  }
  state.cursor = '0';
  state.page = 0;
  state.messages = [];
  renderContacts();
  await loadHistory(revision);
  if (kind === 'text') element('draft').value = '';
  document.querySelector('.chat-record').scrollTop = document.querySelector('.chat-record').scrollHeight;
}

async function showJob() {
  const jobId = location.pathname.split('/').pop().replace(/\.html$/, '');
  const fixtures=await api('/__mock/jobs');
  const row = fixtures.rows.find(item => item.encryptJobId === jobId);
  element('chat-layout').hidden = true;
  element('job-layout').hidden = false;
  if (!row) {
    document.querySelector('.job-banner h1').textContent = '当前模拟账号未找到该职位';
    return;
  }
  document.querySelector('.job-banner h1').textContent = row.jobName;
  const companyLink = document.querySelector('.sider-company .company-info a');
  companyLink.textContent = row.brandName;
  const data=fixtures.details[jobId],job=data.jobInfo;
  element('job-meta').textContent = [job.salaryDesc, job.locationName, job.experienceName, job.degreeName].join('　/　');
  const button=element('job-detail-favorite');
  const render=()=>{button.textContent=data.relationInfo.interestJob?'取消收藏':'收藏';button.classList.toggle('active',data.relationInfo.interestJob);};
  render();button.addEventListener('click',()=>run(async()=>{const favorite=!data.relationInfo.interestJob;await api('/__mock/favorite',{jobId,favorite});data.relationInfo.interestJob=favorite;render();}));
}

async function showFavorites(){
  element('chat-layout').hidden=true;element('favorites-layout').hidden=false;
  const {rows}=await api('/__mock/favorites');
  for(const row of rows){
    const card=node('li','item-boss'+(row.closed?' job-closed':''));card.dataset.jobId=row.encryptJobId;
    const company=node('div','company-info'),brand=node('a','',row.brandName);brand.setAttribute('ka','personal_interest_brand_'+row.encryptBrandId);brand.href='#';company.append(brand);
    const job=node('div','job-info'),link=node('a','name');link.href='/job_detail/'+row.encryptJobId+'.html';link.target='_blank';link.rel='noopener noreferrer';link.append(node('span','job-name-text',row.jobName));job.append(link);
    card.append(company,job);
    if(!row.closed){const cancel=node('button','btn-like','取消感兴趣');cancel.setAttribute('ka','personal_interest_cancel_'+row.encryptJobId);cancel.addEventListener('click',()=>run(async()=>{await api('/__mock/favorite',{jobId:row.encryptJobId,favorite:false});card.remove();}));card.append(cancel);}
    else card.append(node('span','muted','职位已下架'));
    element('favorites-list').append(card);
  }
  element('favorites-count').textContent=rows.length;
}

async function showJobs() {
  element('chat-layout').hidden = true;
  element('jobs-layout').hidden = false;
  const fixtures = await api('/__mock/jobs');
  const listings = fixtures.rows;
  const detail = document.querySelector('#jobs-layout .job-detail-box');
  const pageVue = {$options: {name: 'PageJobs'}, jobList: listings, currentJob: null, jobDetail: {}, jobDetailLoading: false};
  element('jobs-layout').__vue__ = pageVue;
  detail.__vue__ = {$options: {name: 'JodCardDetail'}, $props: {data: {}, loading: false, isScroll: false, isStudent: false, cityCode: '101010100', hideCanFeedback: false}};
  let selection = 0;
  async function choose(row, card) {
    const revision = ++selection;
    for (const item of element('job-results').children) {item.classList.toggle('active', item === card);item.__vue__.$props.isActive = item === card;}
    pageVue.currentJob = row;
    pageVue.jobDetailLoading = true;
    detail.__vue__.$props.loading = true;
    detail.hidden = false;
    element('job-detail-loading').textContent = '正在加载职位详情…';
    element('job-detail-loading').hidden = false;
    if (element('job-detail-mode').value === 'delayed') await new Promise(resolveWait => setTimeout(resolveWait, 1500));
    if (revision !== selection) return;
    const data = fixtures.details[row.encryptJobId];
    pageVue.jobDetail = data;
    pageVue.jobDetailLoading = false;
    detail.__vue__.$props.data = data;
    detail.__vue__.$props.loading = false;
    element('job-detail-loading').textContent = '';
    element('job-detail-loading').hidden = true;
    detail.querySelector('.job-name').textContent = row.jobName;
    detail.querySelector('.brand-name').textContent = row.brandName;
    element('preview-favorite').textContent=data.relationInfo.interestJob?'取消收藏':'收藏';
    const preview = Object.values(fixtures.cases).includes(row.encryptJobId) && row.encryptJobId !== fixtures.cases.existing;
    detail.querySelector('.job-preview-hint').textContent = preview ? '此职位仅存在于浏览列表，不在聊天列表中。' : '此职位也存在于模拟聊天列表，可先采集再验证高亮。';
    const link = detail.querySelector('.job-detail-link');
    link.href = '/job_detail/' + row.encryptJobId + '.html';
    link.hidden = preview;
  }
  for (const row of listings) {
    const card = node('div', 'job-card-wrap');
    card.dataset.jobId = row.encryptJobId;
    card.__vue__ = {$options: {name: 'JodCard'}, $props: {data: row, showBottom: true, showJobType: false, isActive: false}};
    const box = node('div', 'job-card-box'),link = node('a', 'job-name', row.jobName);
    link.href = '/job_detail/' + row.encryptJobId + '.html';
    box.append(link, node('span', 'boss-name', row.brandName));
    card.append(box);
    card.addEventListener('click', event => {event.preventDefault();run(() => choose(row, card));});
    element('job-results').append(card);
  }
  if (listings.length) await choose(listings[0], element('job-results').children[0]);
  element('preview-favorite').addEventListener('click',()=>run(async()=>{const row=pageVue.currentJob,data=pageVue.jobDetail;if(pageVue.jobDetailLoading)return;const favorite=!data.relationInfo.interestJob;await api('/__mock/favorite',{jobId:row.encryptJobId,favorite});data.relationInfo.interestJob=favorite;element('preview-favorite').textContent=favorite?'取消收藏':'收藏';}));
}

const bridgeHint = '未检测到扩展。请加载或重新加载项目根目录下的 extension，然后刷新此页。';
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'boss-local-helper-v1' || event.data.direction !== 'to-extension') return;
  const data = event.data.data;
  element('bridge-status').textContent = '● 已收到真实扩展页面观察事件';
  if (element('notice').textContent === bridgeHint) notice();
  state.bridge.unshift({type: data.type, rows: data.rows?.length, messages: data.messages?.length, sync: data.sync, error: data.error});
  state.bridge = state.bridge.slice(0, 16);
  const content = JSON.stringify(state.bridge, null, 2);
  if (element('bridge-log').textContent !== content) element('bridge-log').textContent = content;
});

setTimeout(() => {
  if (!state.bridge.length) {
    element('bridge-status').textContent = bridgeHint;
    if (element('notice').hidden) notice(bridgeHint);
  }
}, 3000);

async function refreshRequests() {
  if (!element('diagnostics').open) return;
  const requests = await api('/__mock/requests');
  element('request-count').textContent = requests.length;
  const content = requests.slice(-30).reverse().map(item => new Date(item.at).toLocaleTimeString('zh-CN') + '  ' + item.status + '  ' + item.path.split('/').pop() + '  ' + item.bossId + (item.page ? '  page=' + item.page : '')).join('\n') || '暂无请求';
  if (element('request-log').textContent !== content) element('request-log').textContent = content;
}

async function start() {
  state.config = await api('/__mock/state');
  window._PAGE = {uid: state.config.user.userId};
  document.body.__vue__ = {$options: {name: 'App'}, $store: {state: {userInfo: state.config.user}}};
  fillSelect('scenario', state.config.scenarios, state.config.scenario);
  fillSelect('account', state.config.accounts, state.config.account);
  await loadContacts(location.pathname !== '/web/geek/chat');
  if (location.pathname.startsWith('/job_detail/')) await showJob();
  if (location.pathname === '/web/geek/jobs') await showJobs();
  if (location.pathname === '/web/geek/recommend') await showFavorites();
  element('search').addEventListener('input', renderContacts);
  element('reset').addEventListener('click', () => run(reset));
  element('load-contacts').addEventListener('click', () => run(() => loadContacts(true)));
  element('older').addEventListener('click', () => run(() => loadHistory()));
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => run(() => performAction(button.dataset.action))));
  element('send-form').addEventListener('submit', event => {
    event.preventDefault();
    const text = element('draft').value.trim();
    if (text) run(() => performAction('text', text));
  });
  element('diagnostics').addEventListener('toggle', () => run(refreshRequests));
  setInterval(() => run(refreshRequests), 1500);
}

run(start);
