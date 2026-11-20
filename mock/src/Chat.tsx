import {useEffect, useRef, useState} from 'react';
import {api, errorText} from './api.ts';
import type {MockConfig, MockMessage, MockRow} from './types.ts';

const actions = {apply_resume: '申请发简历', resume: '发送简历', read: '对方已读', request_resume: '对方索要简历', view_resume: '对方查看简历', withdraw: '对方撤回消息', unknown_resume: '简历审核中', resume_failed: '简历发送失败 / 被拒绝', invite_interview: '对方发面试邀请', accept_interview: '接受面试邀请', cancel_interview: '对方取消面试', competition_card: '竞争情况卡片', wechat_card: '微信交换卡片', switch_job: '切换同公司 JD'};
export function Chat({config, notice}: {config: MockConfig; notice: (text: string) => void}) {
  const [rows, setRows] = useState<MockRow[]>([]);
  const [ended, setEnded] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<MockMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [draft, setDraft] = useState('');
  const state = useRef({selected: null as string | null, revision: 0, cursor: '0', page: 0, messages: [] as MockMessage[], loading: false});
  const record = useRef<HTMLDivElement>(null);
  async function run(work: () => Promise<void>) {try {await work();} catch (error) {notice(errorText(error));}}
  async function loadContacts(all = false) {
    const result = await api<{rows: MockRow[]; ended: boolean}>('/__mock/list' + (all ? '?all=1' : ''));
    setRows(result.rows); setEnded(result.ended);
  }
  async function loadHistory(revision = state.current.revision) {
    const current = state.current;
    const params = new URLSearchParams({bossId: current.selected || '', securityId: 'synthetic-local-only', maxMsgId: current.cursor, c: '20', page: String(current.page + 1), src: '0'});
    const result = await api<{code: number; zpData: {messages: MockMessage[]; hasMore: boolean; minMsgId: string}}>('/wapi/zpchat/geek/historyMsg?' + params);
    if (revision !== state.current.revision) return;
    if (result.code !== 0) throw new Error('模拟接口 code=' + result.code);
    const data = result.zpData;
    if (!Array.isArray(data?.messages) || typeof data.hasMore !== 'boolean') throw new Error('模拟历史响应结构异常');
    const merged = new Map([...current.messages, ...data.messages].map(message => [message.mid, message]));
    current.messages = [...merged.values()].sort((first, second) => (first.time || 0) - (second.time || 0));
    let more = data.hasMore;
    if (more && current.page > 0 && data.minMsgId === current.cursor) {more = false; notice('检测到模拟游标停滞；已保留加载的消息。');}
    current.cursor = data.minMsgId; current.page++;
    setMessages(current.messages); setHasMore(more);
  }
  async function openConversation(bossId: string) {
    const current = state.current;
    const revision = ++current.revision;
    Object.assign(current, {selected: bossId, cursor: '0', page: 0, messages: []});
    setSelected(bossId); setMessages([]); setHasMore(false); setDraft(''); notice('');
    const result = await api<{row: MockRow}>('/__mock/action', {bossId, kind: 'open'});
    if (revision !== current.revision) return;
    setRows(previous => previous.map(row => row.encryptBossId === bossId ? result.row : row));
    await loadHistory(revision);
  }
  async function performAction(kind: string, text?: string) {
    const current = state.current;
    if (!current.selected) return;
    const revision = current.revision;
    const result = await api<{row: MockRow}>('/__mock/action', {bossId: current.selected, kind, text});
    if (revision !== current.revision) return;
    setRows(previous => previous.map(row => row.encryptBossId === current.selected ? result.row : row));
    Object.assign(current, {cursor: '0', page: 0, messages: []});
    await loadHistory(revision);
    if (revision !== current.revision) return;
    if (kind === 'text') setDraft('');
    if (record.current) record.current.scrollTop = record.current.scrollHeight;
  }
  useEffect(() => {void run(() => loadContacts()); return () => {state.current.revision++;};}, []);
  const row = rows.find(item => item.encryptBossId === selected);
  const visible = rows.filter(item => [item.name, item.brandName, item.jobName].join(' ').toLowerCase().includes(search.toLowerCase()));
  return <main id="chat-layout" className="workspace">
    <section className="contacts" aria-label="联系人列表"><div className="list-heading"><h1>沟通</h1><span id="contact-count" className="muted">{rows.length} 位联系人</span></div><label className="search-label"><span className="sr-only">搜索联系人或公司</span><input id="search" placeholder="搜索联系人、公司或职位" type="search" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="list-caption">全部联系人 <span>模拟数据</span></div>
      <div id="contact-list" data-testid="contact-list" ref={element => {if (element) element.__vue__ = {$options: {name: 'boss-list'}, fullList: rows, isLoading: false, bottomText: ended ? '没有更多了' : '加载更多'};}}>{visible.map(item => <button key={item.encryptBossId} data-boss-id={item.encryptBossId} className={'contact' + (item.encryptBossId === selected ? ' selected' : '')} type="button" aria-label={item.name + '，' + item.brandName + '，' + item.jobName} aria-pressed={item.encryptBossId === selected} onClick={() => void run(() => openConversation(item.encryptBossId))}><span className="avatar">{item.name.slice(0, 1)}</span><div className="contact-content"><div className="contact-top"><strong>{item.name}</strong>{!!item.unreadCount && <span className="unread">{item.unreadCount}</span>}</div><div className="contact-job">{item.brandName} · {item.jobName}</div><div className="contact-preview">{item.lastText}</div></div></button>)}{!visible.length && <p className="list-end">{search ? '没有匹配的联系人' : '暂无沟通记录'}</p>}</div>
      <button id="load-contacts" className="load-more" hidden={ended} onClick={() => void run(() => loadContacts(true))}>加载剩余联系人</button><p id="list-end" className="list-end">{ended ? '没有更多了' : '当前仅加载部分联系人'}</p>
    </section>
    <section className="conversation" aria-label="聊天记录"><div id="chat-empty" className="empty" hidden={!!row}><div className="empty-mark">聊</div><h2>从一次沟通开始</h2><p>选择左侧联系人，查看消息和关联职位。</p><small>用可重复的场景，验证每一步变化。</small></div>
      <div id="chat-active" hidden={!row}><header className="conversation-heading"><div><h2 id="contact-name">{row?.name}</h2><p id="contact-company">{row?.brandName} · 招聘负责人</p></div><span className="tag">模拟联系人</span></header><a id="current-job" className="job-strip" href={row?.encryptJobId ? '/job_detail/' + row.encryptJobId + '.html' : '#'}>{row?.jobName}{row?.encryptJobId ? '　查看职位详情 →' : '　· 暂无可验证 JD'}</a>
        <div className="chat-record" ref={element => {record.current = element; if (element) element.__vue__ = {boss: {encryptBossId: selected}};}}><button id="older" className="load-more" hidden={!hasMore} onClick={() => void run(() => loadHistory())}>加载更早消息</button><div id="messages" data-testid="messages" aria-live="polite">{messages.map(message => {
          const isSelf = message.from?.uid === config.user.userId ? true : message.to?.uid === config.user.userId ? false : null;
          const isSystem = message.body.type === 4;
          const time = message.time ? new Date(message.time).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'}) : '时间未知';
          const messageType = ({1: 'text', 7: 'dialog', 14: 'interview', 16: 'articles'} as Record<number, string>)[message.body.type];
          const visibleText = message.body.text || message.body.dialog?.content || message.body.articles?.map(article => article.title).join('\n');
          return <article key={message.mid} className={'message message-item ' + (isSelf ? 'out' : 'in') + (isSystem ? ' item-system' : '')} data-message-id={message.mid} ref={element => {if (element) element.__vue__ = {$props: {message: {mid: message.mid, time: message.time, type: message.type, bodyType: message.body.type, templateId: message.body.templateId, messageType, isSystem, isSelf, status: message.status, text: message.body.text, dialog: message.body.dialog, articles: message.body.articles}}};}}><span className="avatar">{isSelf ? '我' : row?.name.slice(0, 1)}</span><div className="message-body"><div className="bubble">{visibleText}</div><div className="message-meta">{time}{isSelf ? message.status === 2 ? ' · 已读' : ' · 已送达' : ''}</div></div></article>;
        })}</div></div>
        <div className="composer"><div className="actions" aria-label="模拟沟通操作">{Object.entries(actions).map(([kind, label]) => <button key={kind} data-action={kind} onClick={() => void run(() => performAction(kind))}>{label}</button>)}</div><form id="send-form" onSubmit={event => {event.preventDefault(); if (draft.trim()) void run(() => performAction('text', draft.trim()));}}><label className="sr-only" htmlFor="draft">消息内容</label><textarea id="draft" placeholder="输入一条模拟消息…" maxLength={2000} rows={2} value={draft} onChange={event => setDraft(event.target.value)} /><div className="send-footer"><small>仅修改本地模拟数据</small><button className="primary" type="submit">发送消息</button></div></form></div>
      </div>
    </section>
    <aside className="context-panel"><p className="eyebrow">WORKBENCH</p><h2>验证沟通的每一步</h2><p className="muted">页面结构、接口与插件读取约定保持兼容。</p>{[['页面观察', '切换会话、未读标记、实时消息。'], ['历史采集', '分页、去重、停止和异常中断。'], ['公司与 JD', '同公司多职位、同职位多联系人、缺少 JD。']].map(([title, description], index) => <div className="context-card" key={title}><span>0{index + 1} / {title}</span><p>{description}</p></div>)}</aside>
  </main>;
}
