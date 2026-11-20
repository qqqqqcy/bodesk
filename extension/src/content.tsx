import {useId, useRef, useState, useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import type {ExternalRecord, HumanMessagePreview, WidgetContext, WidgetData, WidgetJob} from './types.ts';
import {jobURL, normalizeStatus, statusLabel} from './status.ts';
import {attachWidgetDragHandle} from './widget-position.ts';

const CHANNEL = 'boss-local-helper-v1';
const statusOptions = ['auto', 'awaiting_self', 'awaiting_boss', 'resume_requested', 'resume_applied', 'resume_sent', 'resume_viewed', 'communication_rejected', 'interviewing', 'passed', 'failed', 'unknown'];
type NoteKind = 'job-note' | 'company-note';
type EditorKind = NoteKind | 'job-status';
interface Draft {
  value: string;
  baseValue: string;
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
const editorKey = (kind: EditorKind, id: string, account = view.context?.account) => JSON.stringify([account, kind, id]);
const errorText = (error: unknown) => error instanceof Error ? error.message : '本地操作失败';
const post = (data: ExternalRecord) => window.postMessage({channel: CHANNEL, direction: 'to-page', data}, location.origin);

function activateEditor(key: string) {
  renderVersion++;
  update({editor: key, session: view.session + 1});
}

function openNoteEditor(kind: NoteKind, id: string, initial: string) {
  if (!view.context || view.context.preview || !id) return;
  const key = editorKey(kind, id);
  if (view.editor === key) return;
  if (!drafts.has(key)) drafts.set(key, {value: initial, baseValue: initial, revision: 0});
  activateEditor(key);
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

function NoteEditor({kind, id, title}: {kind: NoteKind; id: string; title?: string}) {
  const key = editorKey(kind, id);
  const draft = drafts.get(key)!;
  const [value, setValue] = useState(draft.value);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  const context = view.context!;
  const data = view.data!;
  const session = view.session;
  const label = kind === 'job-note' ? 'JD 备注' : '公司备注';
  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const {revision, baseValue} = draft;
    setSaving(true); setFeedback('正在保存…');
    let message: ExternalRecord | undefined;
    if (value !== baseValue) {
      if (kind === 'company-note') message = {type: 'SAVE_COMPANY_NOTE', account: context.account, companyId: id, companyName: data.companyName, note: value, expectedNote: baseValue};
      else message = {
        type: 'SAVE_JOB', account: context.account, jobId: id,
        note: value, expectedNote: baseValue,
        context: {companyId: data.companyId, companyName: data.companyName, title},
      };
    }
    try {
      if (message) {const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error || '本地保存失败');}
      const owns = view.context === context && view.editor === key && view.session === session;
      if (drafts.get(key) === draft) {
        if (message) draft.baseValue = value;
        if (draft.revision === revision && (owns || view.editor !== key)) drafts.delete(key);
      }
      if (owns) {update({editor: null}); await refreshWidget(); showNotice(message ? '已保存备注' : '没有更改');}
    } catch (error) {setFeedback(errorText(error)); setSaving(false);}
  }
  return <form className="bh-editor" onSubmit={save}>
    <label className="bh-field">{label}
      <textarea className="bh-note-input" rows={3} maxLength={10000} value={value} disabled={saving} autoFocus placeholder={kind === 'company-note' ? '记录这家公司的沟通情况、偏好等' : '记录这个职位的沟通要点、面试安排等'} onChange={event => {
        draft.value = event.target.value;
        draft.revision++;
        setValue(draft.value);
      }} />
    </label>
    <p className="bh-editor-feedback" role="status" hidden={!feedback}>{feedback}</p>
    <div className="bh-editor-actions"><button className="bh-save" type="submit" disabled={saving}>保存备注</button><button className="bh-cancel" type="button" disabled={saving} onClick={() => {drafts.delete(key); update({editor: null}); void refreshWidget();}}>取消</button></div>
  </form>;
}

const statusOptionLabel = (value: string) => value === 'auto' ? '跟随自动判断' : statusLabel(value);

function showStatusConfirmation(dialog: HTMLDialogElement | null) {
  if (!dialog) return;
  dialog.showModal();
  return () => dialog.close();
}

function StatusPicker({id, job, editor, dismiss}: {id: string; job: WidgetJob; editor: string; dismiss: () => Promise<void>}) {
  const [selection, setSelection] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const context = view.context!;
  const data = view.data!;
  const session = view.session;
  const manualStatus = job.manual ? normalizeStatus(job.status) : null;
  const current = manualStatus ?? 'auto';
  const options = statusOptions.includes(current) ? statusOptions : [...statusOptions, current];
  const firstChoice = options.find(option => option !== current);

  function cancel() {
    if (saving) return;
    setSelection(null);
    setError('');
  }

  async function confirm() {
    if (!selection || saving || view.editor !== editor || view.session !== session) return;
    setSaving(true);
    setError('');
    try {
      const result = await chrome.runtime.sendMessage({type: 'SAVE_JOB', account: context.account, jobId: job.id,
        status: selection, expectedManualStatus: manualStatus,
        context: {companyId: data.companyId, companyName: data.companyName, title: job.title},
      });
      if (!result?.ok) throw new Error(result?.error || '本地保存失败');
      if (view.context === context && view.editor === editor && view.session === session) {
        await dismiss();
        if (view.context === context && !view.editor) showNotice('已保存状态');
      }
    } catch (failure) {
      setError(errorText(failure));
      setSaving(false);
    }
  }

  return <>
    <div id={id} className="bh-status-picker" role="group" aria-label="职位状态选项" onKeyDown={event => {
      if (event.key === 'Escape') {event.stopPropagation(); void dismiss();}
    }}>
      {options.map(option => <button className="bh-status-option" type="button" key={option} value={option}
        disabled={option === current} autoFocus={option === firstChoice} onClick={() => setSelection(option)}>
        {statusOptionLabel(option)}{option === current && <span>当前</span>}
      </button>)}
    </div>
    {selection && <dialog className="bh-status-dialog" ref={showStatusConfirmation} aria-labelledby={id + '-title'} aria-describedby={id + '-change'}
      onCancel={event => {event.preventDefault(); cancel();}}>
      <h3 id={id + '-title'}>确认修改职位状态</h3>
      <p id={id + '-change'}>将「{job.title || '当前职位'}」的状态设为「{statusOptionLabel(selection)}」？</p>
      {error && <p className="bh-status-error" role="alert">{error}</p>}
      <div className="bh-editor-actions">
        <button className="bh-cancel" type="button" autoFocus disabled={saving} onClick={cancel}>取消</button>
        <button className="bh-save" type="button" disabled={saving} onClick={() => void confirm()}>{saving ? '正在保存…' : '确认修改'}</button>
      </div>
    </dialog>}
  </>;
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
  const statusButton = useRef<HTMLButtonElement>(null);
  const statusPickerId = useId();
  const url = jobURL(job.url);
  const statusKey = editorKey('job-status', job.id);
  const noteKey = editorKey('job-note', job.id);
  const status = !job.manual && job.status === 'resume_event' && job.label ? job.label : statusLabel(job.status);
  const statusText = status + (job.manual ? '（手动）' : '');
  const statusOpen = view.editor === statusKey;
  const canEditStatus = !context.preview && !!job.id;
  async function dismissStatus() {
    update({editor: null});
    await refreshWidget();
    if (view.context === context && !view.editor) statusButton.current?.focus();
  }
  const openNote = () => openNoteEditor('job-note', job.id, job.note || '');
  async function remove() {
    if (view.editor) {showNotice('请先保存或取消正在编辑的内容'); return;}
    if (!window.confirm('确定删除“' + (job.title || '未命名职位') + '”？该职位的备注和状态将被删除，之后不会自动重新收录；已有对话会保留。')) return;
    setDeleting(true);
    try {
      const result = await chrome.runtime.sendMessage({type: 'DELETE_JOB', account: context.account, jobId: job.id, expectedUpdatedAt: job.updatedAt});
      if (!result?.ok) throw new Error(result?.error || '删除职位失败');
      drafts.delete(editorKey('job-note', job.id, context.account));
      if (view.context?.account === context.account) {await refreshWidget(); showNotice('已删除“' + (job.title || '未命名职位') + '”。');}
      else showNotice('职位已删除。');
    } catch (error) {showNotice(errorText(error));} finally {setDeleting(false);}
  }
  return <article className={'bh-job' + (job.current ? ' bh-current' : '')} aria-current={job.current ? 'true' : undefined}>
    {job.current && <span className="bh-current-label">当前职位</span>}
    <div className="bh-job-heading-row">
      <h3 className="bh-job-heading">{url ? <a className="bh-job-title" href={url} target="_blank" rel="noopener noreferrer">{job.title || '待识别 JD'}</a> : <span className="bh-job-title">{job.title || '待识别 JD'}</span>}</h3>
      {job.favorite && <span className="bh-favorite">已收藏</span>}
    </div>
    <div className="bh-job-line">
      <span className="bh-record-label">沟通状态</span>
      <button ref={statusButton} className="bh-job-status" type="button" disabled={!canEditStatus}
        aria-label={canEditStatus ? statusText + '，修改' + (job.title || '当前职位') + '的状态' : undefined}
        aria-expanded={canEditStatus ? statusOpen : undefined} aria-controls={statusOpen ? statusPickerId : undefined}
        onClick={() => {if (statusOpen) void dismissStatus(); else activateEditor(statusKey);}}
        onKeyDown={event => {if (statusOpen && event.key === 'Escape') {event.stopPropagation(); void dismissStatus();}}}>{statusText}</button>
    </div>
    {statusOpen && <StatusPicker key={view.session} id={statusPickerId} job={job} editor={statusKey} dismiss={dismissStatus} />}
    {job.latestMessage && <LatestMessage {...job.latestMessage} />}
    {view.editor === noteKey ? <NoteEditor key={noteKey + ':' + view.session} kind="job-note" id={job.id} title={job.title} /> : <>
      {job.note && <p className="bh-note-text">{job.note}</p>}
      {!!job.noteConflicts?.length && <details className="bh-note-history"><summary>合并前的备注（{job.noteConflicts.length}）</summary>{job.noteConflicts.map((note, index) => <p className="bh-note-text" key={index}>{note.text}</p>)}</details>}
      <div className="bh-job-actions">{!context.preview && <button className="bh-link-button bh-job-note-edit" type="button" disabled={!job.id} onClick={openNote}>{job.note ? '编辑备注' : '添加备注'}</button>}<button className="bh-link-button bh-job-delete" type="button" disabled={deleting || !job.id || !job.persisted} aria-label={'删除 ' + (job.title || '未命名职位')} onClick={() => void remove()}>删除</button></div>
    </>}
  </article>;
}

function Widget() {
  const current = useSyncExternalStore(subscribe, getSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  const {context, data, editor, session, notice} = current;
  const companyId = data?.companyId || '';
  const key = editorKey('company-note', companyId);
  async function dashboard() {
    try {
      const result = await chrome.runtime.sendMessage({type: 'OPEN_DASHBOARD', account: context?.account || lastAccount});
      if (!result?.ok) showNotice(result?.error || '打开采集页面失败');
    } catch {showNotice('扩展已更新，请刷新页面');}
  }
  return <>
    <div className="bh-widget-header">
      <div className="bh-widget-drag" ref={attachWidgetDragHandle} role="group" tabIndex={0} aria-label="拖动浮窗，或用方向键移动" aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight" title="拖动浮窗" />
      <h2 className="bh-company" hidden={collapsed}>{data?.companyName || context?.companyName || (data ? '公司待识别' : '请选择一个对话或职位')}</h2>
      <button className="bh-widget-toggle" type="button" aria-expanded={!collapsed} aria-controls="boss-local-helper-widget-body" onClick={() => setCollapsed(previous => !previous)}>
        {collapsed ? '展开浮窗' : '收起'}
      </button>
    </div>
    <div id="boss-local-helper-widget-body" className="bh-widget-body" hidden={collapsed}>
      <div className="bh-records">
        {context && <div className="bh-company-notes">
          {editor === key ? <NoteEditor key={key + ':' + session} kind="company-note" id={companyId} /> : <>
            <div className="bh-company-note-heading">
              <span className="bh-record-label">公司备注</span>
              <button className="bh-link-button bh-company-note-edit" type="button" aria-label={data?.companyNote ? '编辑公司备注' : '添加公司备注'} disabled={!companyId || context.preview} onClick={() => openNoteEditor('company-note', companyId, data?.companyNote || '')}>{data?.companyNote ? '编辑' : '添加'}</button>
            </div>
            {data?.companyNote && <p className="bh-note-text">{data.companyNote}</p>}
          </>}
        </div>}
        {context && !!data?.jobs?.length && <section className="bh-jobs" aria-labelledby="bh-jobs-heading">
          <div className="bh-jobs-heading"><h2 id="bh-jobs-heading">职位记录</h2><span>{data.jobs.length} 个</span></div>
          {data.jobs.map(job => <Job key={context.account + ':' + job.id} job={job} context={context} />)}
        </section>}
        <p className="bh-notice" role="status" hidden={!notice}>{notice}</p>
      </div>
      <div className="bh-controls"><button className="bh-overview" type="button" onClick={() => void dashboard()}>采集与导出</button></div>
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
    sendResponse({ready: !view.editor && ![...drafts.values()].some(draft => draft.value !== draft.baseValue)});
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
