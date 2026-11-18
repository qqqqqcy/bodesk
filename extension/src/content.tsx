import {useState, useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import type {ExternalRecord, HumanMessagePreview, WidgetContext, WidgetData, WidgetJob} from './types.ts';
import {jobURL, normalizeStatus, statusLabel} from './status.ts';
import {attachWidgetDragHandle} from './widget-position.ts';

const CHANNEL = 'boss-local-helper-v1';
interface Draft {
  note: string;
  status?: string;
  baseNote: string;
  baseStatus?: string;
  revision: number;
}
interface View {
  context: WidgetContext | null;
  data: WidgetData | null;
  editor: string | null;
  session: number;
  notice: string;
}
let view: View = {context: null, data: null, editor: null, session: 0, notice: ''};
const listeners = new Set<() => void>();
const drafts = new Map<string, Draft>();
const pending = new Map<string, {timer: ReturnType<typeof setTimeout>; resolve: (value: unknown) => void}>();
let lastAccount: string | null = null;
let renderVersion = 0;
let widget: HTMLElement | null = null;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const subscribe = (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};};
const getSnapshot = () => view;
function update(patch: Partial<View>) {view = {...view, ...patch}; for (const listener of listeners) listener();}
const showNotice = (notice: string) => update({notice});
const editorKey = (kind: string, id?: string) => JSON.stringify([view.context?.account, kind, id]);
const errorText = (error: unknown) => error instanceof Error ? error.message : '本地操作失败';
const post = (data: ExternalRecord) => window.postMessage({channel: CHANNEL, direction: 'to-page', data}, location.origin);

function openEditor(kind: string, id: string, initial: {note: string; status?: string}) {
  if (!view.context || view.context.preview || !id) return;
  const key = editorKey(kind, id);
  if (!drafts.has(key)) drafts.set(key, {...initial, baseNote: initial.note, baseStatus: initial.status, revision: 0});
  renderVersion++;
  update({editor: key, session: view.session + 1});
}

async function refreshWidget() {
  if (!document.body || view.editor) return;
  ensureWidget();
  const context = view.context;
  if (!context) return;
  const version = ++renderVersion;
  try {
    const response = await chrome.runtime.sendMessage({type: 'WIDGET_GET', ...context});
    if (version !== renderVersion || context !== view.context || view.editor) return;
    if (!response?.ok) {showNotice(response?.error || '本地职位状态读取失败'); return;}
    const data: WidgetData = response.data || {};
    if (JSON.stringify(data) !== JSON.stringify(view.data)) update({data, notice: data.jobs?.length ? '' : '暂无已记录的 JD'});
  } catch {if (version === renderVersion) showNotice('扩展连接中断，请刷新页面');}
}

function Editor({kind, id, job}: {kind: 'job' | 'company'; id: string; job?: WidgetJob}) {
  const key = editorKey(kind, id);
  const draft = drafts.get(key)!;
  const [note, setNote] = useState(draft.note);
  const [status, setStatus] = useState(draft.status || 'auto');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  const context = view.context!;
  const data = view.data!;
  const session = view.session;
  const options = ['auto', 'awaiting_self', 'awaiting_boss', 'resume_requested', 'resume_applied', 'resume_sent', 'resume_viewed', 'communication_rejected', 'interviewing', 'passed', 'failed', 'unknown'];
  if (job?.manual && !options.includes(normalizeStatus(job.status))) options.push(normalizeStatus(job.status));
  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const submitted = {note, status: kind === 'job' ? status : undefined, revision: draft.revision};
    const noteChanged = submitted.note !== draft.baseNote;
    const statusChanged = kind === 'job' && submitted.status !== draft.baseStatus;
    setSaving(true); setFeedback('正在保存…');
    let message: ExternalRecord | undefined;
    if (kind === 'company' && noteChanged) message = {type: 'SAVE_COMPANY_NOTE', account: context.account, companyId: id, companyName: data.companyName, note, expectedNote: draft.baseNote};
    if (kind === 'job' && (noteChanged || statusChanged)) message = {
      type: 'SAVE_JOB', account: context.account, jobId: id,
      ...(statusChanged ? {status, expectedManualStatus: draft.baseStatus === 'auto' ? null : draft.baseStatus} : {}),
      ...(noteChanged ? {note, expectedNote: draft.baseNote} : {}),
      context: {companyId: data.companyId, companyName: data.companyName, title: job?.title},
    };
    try {
      if (message) {const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error || '本地保存失败');}
      const owns = view.context === context && view.editor === key && view.session === session;
      if (drafts.get(key) === draft) {
        if (noteChanged) draft.baseNote = submitted.note;
        if (statusChanged) draft.baseStatus = submitted.status;
        if (draft.revision === submitted.revision && (owns || view.editor !== key)) drafts.delete(key);
      }
      if (owns) {update({editor: null}); await refreshWidget(); showNotice(message ? '已保存' : '没有更改');}
    } catch (error) {setFeedback(errorText(error)); setSaving(false);}
  }
  return <form className="bh-editor" onSubmit={save}>
    {kind === 'job' && <label className="bh-field">当前状态<select className="bh-status-select" aria-label="修改职位状态" value={status} disabled={saving} onChange={event => {draft.status = event.target.value; draft.revision++; setStatus(draft.status);}}>
      {options.map(value => <option key={value} value={value}>{value === 'auto' ? '跟随自动判断' : statusLabel(value)}</option>)}
    </select></label>}
    <label className="bh-field">{kind === 'company' ? '公司备注' : 'JD 备注'}<textarea className="bh-note-input" aria-label={kind === 'company' ? '公司备注' : 'JD 备注'} rows={3} maxLength={10000} value={note} disabled={saving} placeholder={kind === 'company' ? '记录这家公司的沟通情况、偏好等' : '记录这个职位的沟通要点、面试安排等'} onChange={event => {draft.note = event.target.value; draft.revision++; setNote(draft.note);}} /></label>
    <p className="bh-editor-feedback" role="status" hidden={!feedback}>{feedback}</p>
    <div className="bh-editor-actions"><button className="bh-save" type="submit" disabled={saving}>保存</button><button className="bh-cancel" type="button" disabled={saving} onClick={() => {drafts.delete(key); update({editor: null}); void refreshWidget();}}>取消</button></div>
  </form>;
}

function LatestMessage({text, direction}: HumanMessagePreview) {
  const sender = direction === 'out' ? '我' : direction === 'in' ? 'Boss' : '发送方未知';
  return <div className={'bh-message-preview bh-message-' + direction} role="group" aria-label="最新人工消息" tabIndex={0}>
    <span className="bh-message-sender">{sender}</span>
    <span className="bh-message-text">{text}</span>
  </div>;
}

function Job({job, context}: {job: WidgetJob; context: WidgetContext}) {
  const [deleting, setDeleting] = useState(false);
  const url = jobURL(job.url);
  const key = editorKey('job', job.id);
  const open = () => openEditor('job', job.id, {status: job.manual ? normalizeStatus(job.status) : 'auto', note: job.note || ''});
  async function remove() {
    if (view.editor) {showNotice('请先保存或取消正在编辑的内容'); return;}
    if (!window.confirm('确定删除“' + (job.title || '未命名职位') + '”？该职位的备注和状态将被删除，之后不会自动重新收录；已有对话会保留。')) return;
    setDeleting(true);
    try {
      const result = await chrome.runtime.sendMessage({type: 'DELETE_JOB', account: context.account, jobId: job.id, expectedUpdatedAt: job.updatedAt});
      if (!result?.ok) throw new Error(result?.error || '删除职位失败');
      drafts.delete(JSON.stringify([context.account, 'job', job.id]));
      if (view.context?.account === context.account) {await refreshWidget(); showNotice('已删除“' + (job.title || '未命名职位') + '”。');}
      else showNotice('职位已删除。');
    } catch (error) {showNotice(errorText(error));} finally {setDeleting(false);}
  }
  return <div className={'bh-job' + (job.current ? ' bh-current' : '')} aria-current={job.current ? 'true' : undefined}>
    <div className="bh-job-line">{url ? <a className="bh-job-title" href={url} target="_blank" rel="noopener noreferrer">{job.title || '待识别 JD'}</a> : <span className="bh-job-title">{job.title || '待识别 JD'}</span>}
      <button className="bh-job-status" type="button" disabled={context.preview || !job.id} aria-label={(context.preview ? '查看 ' : '修改 ') + (job.title || '当前职位') + ' 的状态'} onClick={open}>{(!job.manual && job.status === 'resume_event' && job.label ? job.label : statusLabel(job.status)) + (job.manual ? '（手动）' : '')}</button></div>
    {job.favorite && <span className="bh-favorite">已收藏</span>}
    {job.latestMessage && <LatestMessage {...job.latestMessage} />}
    {view.editor === key ? <Editor key={key + ':' + view.session} kind="job" id={job.id} job={job} /> : <>
      {job.note && <p className="bh-note-text">{job.note}</p>}
      {!!job.noteConflicts?.length && <details className="bh-note-history"><summary>合并前的备注（{job.noteConflicts.length}）</summary>{job.noteConflicts.map((note, index) => <p className="bh-note-text" key={index}>{note.text}</p>)}</details>}
      <div className="bh-job-actions">{!context.preview && <button className="bh-link-button bh-job-note-edit" type="button" disabled={!job.id} onClick={open}>{job.note ? '编辑备注' : '添加备注'}</button>}<button className="bh-link-button bh-job-delete" type="button" disabled={deleting || !job.id || !job.persisted} aria-label={'删除 ' + (job.title || '未命名职位')} onClick={() => void remove()}>删除</button></div>
    </>}
  </div>;
}

function Widget() {
  const current = useSyncExternalStore(subscribe, getSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  const {context, data, editor, session, notice} = current;
  const companyId = data?.companyId || '';
  const key = editorKey('company', companyId);
  async function dashboard() {
    try {
      const result = await chrome.runtime.sendMessage({type: 'OPEN_DASHBOARD', account: context?.account || lastAccount});
      if (!result?.ok) showNotice(result?.error || '打开采集页面失败');
    } catch {showNotice('扩展已更新，请刷新页面');}
  }
  return <>
    <div className="bh-widget-header">
      <div className="bh-widget-drag" ref={attachWidgetDragHandle} role="group" tabIndex={0} aria-label="拖动浮窗，或用方向键移动" aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight" title="拖动浮窗"><span aria-hidden="true">⠿</span></div>
      <div className="bh-company-line" hidden={collapsed}>
        <strong className="bh-company">{data?.companyName || context?.companyName || (data ? '公司待识别' : '请选择一个对话或职位')}</strong>
        <button className="bh-link-button" type="button" aria-label="编辑公司备注" disabled={!companyId || context?.preview} onClick={() => openEditor('company', companyId, {note: data?.companyNote || ''})}>备注</button>
      </div>
      <button className="bh-widget-toggle" type="button" aria-expanded={!collapsed} aria-controls="boss-local-helper-widget-body" onClick={() => setCollapsed(previous => !previous)}>
        {collapsed ? '展开浮窗' : '收起'}
      </button>
    </div>
    <div id="boss-local-helper-widget-body" className="bh-widget-body" hidden={collapsed}>
      <div className="bh-company-notes">{editor === key ? <Editor key={key + ':' + session} kind="company" id={companyId} /> : data?.companyNote && <p className="bh-note-text">{data.companyNote}</p>}</div>
      <div className="bh-jobs">{context && data?.jobs?.map(job => <Job key={context.account + ':' + job.id} job={job} context={context} />)}</div>
      <p className="bh-notice" role="status" hidden={!notice}>{notice}</p>
      <div className="bh-controls"><button className="bh-overview" type="button" onClick={() => void dashboard()}>采集 / 导出</button></div>
    </div>
  </>;
}

function ensureWidget() {
  if (widget?.isConnected) return;
  widget = document.createElement('aside');
  widget.id = 'boss-local-helper-widget';
  widget.setAttribute('aria-label', '公司与职位沟通状态');
  document.body.append(widget);
  createRoot(widget).render(<Widget />);
  refreshTimer ??= setInterval(() => {if (view.context && !document.hidden && !view.editor) void refreshWidget();}, 5000);
}

function chooseContext(data: ExternalRecord) {
  let next: WidgetContext | null = null;
  if (data.type === 'PAGE_CONTEXT') next = {account: data.account, jobId: data.jobId || '', companyName: data.companyName || '', title: data.title || '', preview: true};
  if (data.type === 'SNAPSHOT') {
    const row = (data.rows || []).find((item: ExternalRecord) => item.id === data.selectedId);
    if (row) next = {account: data.account, jobId: row.jobId || '', companyName: row.companyName || '', title: row.jobTitle || ''};
  }
  if (!['PAGE_CONTEXT', 'SNAPSHOT'].includes(data.type) || JSON.stringify(next) === JSON.stringify(view.context)) return;
  renderVersion++;
  update({context: next, data: null, editor: null, session: view.session + 1, notice: next ? '正在读取职位状态…' : ''});
  if (document.body) ensureWidget();
}

window.addEventListener('message', async event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL || event.data.direction !== 'to-extension') return;
  const data = event.data.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'COMMAND_RESULT') {const command = pending.get(data.commandId); if (command) {clearTimeout(command.timer); pending.delete(data.commandId); command.resolve(data);} return;}
  if (!['SNAPSHOT', 'CONVERSATION', 'SYNC_PROGRESS', 'SYNC_ERROR', 'PAGE_CONTEXT', 'FAVORITES'].includes(data.type)) return;
  if (typeof data.account === 'string') lastAccount = data.account;
  chooseContext(data);
  try {
    const result = await chrome.runtime.sendMessage({type: 'INGEST', data});
    if (data.requestId) post({type: 'INGEST_ACK', requestId: data.requestId, account: data.account, runId: data.runId, ok: result?.ok === true, error: result?.error || (!result?.ok ? '本地数据库更新失败' : undefined)});
    if (!document.body) return;
    ensureWidget();
    if (!result?.ok) {showNotice(result?.error || '本地数据库更新失败'); return;}
    if (view.context?.account === data.account && ['SNAPSHOT', 'CONVERSATION', 'PAGE_CONTEXT', 'FAVORITES'].includes(data.type)) await refreshWidget();
  } catch {
    if (data.requestId) post({type: 'INGEST_ACK', requestId: data.requestId, account: data.account, runId: data.runId, ok: false, error: '扩展连接中断，请刷新页面'});
    showNotice('扩展连接中断，请刷新页面');
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'BUILD_RELOAD_READY') {
    sendResponse({ready: !view.editor && ![...drafts.values()].some(draft => draft.note !== draft.baseNote || draft.status !== draft.baseStatus)});
    return;
  }
  if (message.type === 'ACCOUNT_INFO') {sendResponse({account: lastAccount}); return;}
  if (!['SYNC', 'STOP_SYNC'].includes(message.type)) return;
  const commandId = crypto.randomUUID();
  const timer = setTimeout(() => {pending.delete(commandId); sendResponse({ok: false, error: '网页未响应，请确认聊天页已加载并刷新'});}, 12000);
  pending.set(commandId, {timer, resolve: sendResponse});
  post({type: message.type, commandId, account: message.account, runId: message.runId});
  return true;
});
document.addEventListener('visibilitychange', () => {if (!document.hidden && view.context && !view.editor) void refreshWidget();});
if (document.body) ensureWidget();
else document.addEventListener('DOMContentLoaded', () => {ensureWidget(); void refreshWidget();}, {once: true});
post({type: 'SNAPSHOT'});
