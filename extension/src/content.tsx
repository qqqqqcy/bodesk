import {useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown, Loader, More, Trash} from 'reicon';
import {FavoriteMark, Icon} from './icon.tsx';
import {MessageReceipt, messageSenders} from './message-receipt.tsx';
import {NoteIcon, showEditorDialog, statusOptionLabel, StatusOptions} from './record-editing.tsx';
import type {ExternalRecord, HumanMessagePreview, WidgetContext, WidgetData, WidgetJob} from './types.ts';
import {formatRelativeStatusDate, jobURL, normalizeStatus, statusLabel} from './status.ts';
import {attachWidgetDragHandle} from './widget-position.ts';
import './typography.css';
import '../content.css';

const statusDateFormat = new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});

const CHANNEL = 'boss-local-helper-v1';
type NoteKind = 'job-note' | 'company-note';
type EditorKind = NoteKind | 'job-status' | 'company-delete' | 'job-delete';
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
  loading: boolean;
}
let view: View = {context: null, data: null, editor: null, session: 0, notice: '', loading: false};
const listeners = new Set<() => void>();
const drafts = new Map<string, Draft>();
const pending = new Map<string, {timer: ReturnType<typeof setTimeout>; resolve: (value: unknown) => void}>();
let lastAccount: string | null = null;
let renderVersion = 0;
let widget: HTMLElement | null = null;
let editorTrigger: HTMLElement | null = null;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const subscribe = (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};};
const getSnapshot = () => view;
function update(patch: Partial<View>) {view = {...view, ...patch}; for (const listener of listeners) listener();}
const showNotice = (notice: string) => update({notice});
const editorKey = (kind: EditorKind, id: string, account = view.context?.account) => JSON.stringify([account, kind, id]);
const errorText = (error: unknown) => error instanceof Error ? error.message : '本地操作失败';
const post = (data: ExternalRecord) => window.postMessage({channel: CHANNEL, direction: 'to-page', data}, location.origin);

function activateEditor(key: string) {
  editorTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  renderVersion++;
  update({editor: key, session: view.session + 1});
}

function closeEditor(restoreFocus = true) {
  update({editor: null});
  if (restoreFocus) editorTrigger?.focus({preventScroll: true});
  editorTrigger = null;
  return refreshWidget();
}

function openNoteEditor(kind: NoteKind, id: string, initial: string) {
  if (!view.context || !id) return;
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
    if (!response?.ok) {update({loading: false, notice: response?.error || '本地职位状态读取失败'}); return;}
    const data: WidgetData = response.data || {};
    const nextNotice = data.companyDeleted ? '该公司的本地记录已删除' : data.jobs?.length ? '' : '暂无已记录的 JD';
    if (JSON.stringify(data) !== JSON.stringify(view.data) || view.loading || view.notice !== nextNotice) update({data, loading: false, notice: nextNotice});
  } catch {if (version === renderVersion) update({loading: false, notice: '扩展连接中断，请刷新页面'});}
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
  const headingId = useId();
  function close(discard: boolean, restoreFocus = true) {
    if (saving) return;
    if (discard) drafts.delete(key);
    void closeEditor(restoreFocus);
  }
  useDismissOutside(key, () => close(false, false));
  const layer = usePanelLayer();
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
        context: {companyId: data.companyId, companyName: data.companyName, title, ...(context.preview ? {preview: true} : {}), ...(typeof context.jobClosed === 'boolean' ? {jobClosed: context.jobClosed} : {})},
      };
    }
    try {
      if (message) {const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error || '本地保存失败');}
      const owns = view.context === context && view.editor === key && view.session === session;
      if (drafts.get(key) === draft) {
        if (message) draft.baseValue = value;
        if (draft.revision === revision && (owns || view.editor !== key)) drafts.delete(key);
      }
      if (owns) {await closeEditor(); if (view.session === session) showNotice(message ? '已保存备注' : '没有更改');}
    } catch (error) {setFeedback(errorText(error)); setSaving(false);}
  }
  return <div ref={layer} className="bh-layer" role="dialog" aria-labelledby={headingId} onKeyDown={event => {
    if (event.key === 'Escape') {event.stopPropagation(); close(false);}
  }}>
    <h3 id={headingId}>{title ? title + ' · ' + label : label}</h3>
    <form className="bh-editor" onSubmit={save}>
      <textarea className="bh-note-input" aria-labelledby={headingId} rows={4} maxLength={10000} value={value} disabled={saving} autoFocus onChange={event => {
        draft.value = event.target.value;
        draft.revision++;
        setValue(draft.value);
      }} />
      <p className="bh-editor-feedback" role="status" hidden={!feedback}>{feedback}</p>
      <div className="bh-editor-actions"><button className="bh-cancel" type="button" disabled={saving} onClick={() => close(true)}>取消</button><button className="bh-save" type="submit" aria-busy={saving} disabled={saving}>{saving ? <><span className="bh-spinner"><Icon icon={Loader} /></span>正在保存…</> : '保存备注'}</button></div>
    </form>
  </div>;
}

function usePanelLayer() {
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = layer.current;
    if (!panel) return;
    function place() {
      if (!widget || !panel) return;
      const bounds = widget.getBoundingClientRect();
      const width = panel.offsetWidth;
      const above = Math.max(8, Math.min(bounds.top, window.innerHeight - panel.offsetHeight - 8));
      const beside = bounds.left >= width + 16 ? bounds.left - width - 8 : bounds.right + width + 16 <= window.innerWidth ? bounds.right + 8 : null;
      panel.style.left = beside === null ? '' : beside + 'px';
      panel.style.right = beside === null ? '' : 'auto';
      panel.style.top = beside === null ? '' : above + 'px';
      panel.style.bottom = beside === null ? '' : 'auto';
    }
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);
  return layer;
}

function useDismissOutside(editor: string, dismiss: (restoreFocus: boolean) => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    function closeOutside(event: PointerEvent) {
      if (view.editor === editor && !widget?.contains(event.target as Node)) dismiss(false);
    }
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [dismiss, editor, enabled]);
}

function StatusPicker({id, job, editor, previousStatus, dismiss}: {id: string; job: WidgetJob; editor: string; previousStatus: string; dismiss: (restoreFocus?: boolean) => Promise<void>}) {
  const [selection, setSelection] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const context = view.context!;
  const data = view.data!;
  const session = view.session;
  const manualStatus = job.manual ? normalizeStatus(job.status) : null;
  const current = manualStatus ?? 'auto';
  const layer = usePanelLayer();
  useDismissOutside(editor, dismiss, !selection);

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
        context: {companyId: data.companyId, companyName: data.companyName, title: job.title, ...(context.preview ? {preview: true} : {}), ...(typeof context.jobClosed === 'boolean' ? {jobClosed: context.jobClosed} : {})},
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
    <div ref={layer} id={id} className="bh-layer" role="dialog" aria-labelledby={id + '-options'} onKeyDown={event => {
      if (event.key === 'Escape') {event.stopPropagation(); void dismiss();}
    }}>
      <h3 id={id + '-options'}>{job.title || '当前职位'} · 修改状态</h3>
      <StatusOptions current={current} onSelect={setSelection} />
      <button className="bh-layer-close" type="button" onClick={() => void dismiss()}>关闭</button>
    </div>
    {selection && <dialog className="bh-layer bh-status-dialog" ref={showEditorDialog} aria-labelledby={id + '-title'} aria-describedby={id + '-change'}
      onCancel={event => {event.preventDefault(); cancel();}}>
      <h3 id={id + '-title'}>确认修改职位状态</h3>
      <p id={id + '-change'}>将「{job.title || '当前职位'}」的状态从「{previousStatus}」改为「{statusOptionLabel(selection)}」？</p>
      {error && <p className="bh-status-error" role="alert">{error}</p>}
      <div className="bh-editor-actions">
        <button className="bh-cancel" type="button" autoFocus disabled={saving} onClick={cancel}>取消</button>
        <button className="bh-save" type="button" aria-busy={saving} disabled={saving} onClick={() => void confirm()}>{saving ? <><span className="bh-spinner"><Icon icon={Loader} /></span>正在保存…</> : '确认修改'}</button>
      </div>
    </dialog>}
  </>;
}

function LatestMessage({text, direction, receipt}: HumanMessagePreview) {
  const [overflows, setOverflows] = useState(false);
  const [expandedText, setExpandedText] = useState<string | null>(null);
  const message = useRef<HTMLSpanElement>(null);
  const messageId = useId();
  const expanded = expandedText === text;
  const sender = messageSenders[direction];

  useLayoutEffect(() => {
    const element = message.current;
    if (!element) return;
    const measure = () => {
      const {width, height} = element.getBoundingClientRect();
      if (width === 0) return;
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
      setOverflows(height > 2 * lineHeight + 0.5);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return <div className={'bh-message-preview bh-message-' + direction} role="group" aria-label="最后一条对话">
    <div className="bh-message-row">
      <div id={messageId} className="bh-message-body" data-expanded={expanded}>
        <span className="bh-message-text" ref={message}>{text}</span>
      </div>
      {overflows && <button className="bh-icon-button bh-message-toggle" type="button" aria-label={expanded ? '收起消息' : '展开消息'} aria-controls={messageId} aria-expanded={expanded} onClick={() => setExpandedText(expanded ? null : text)}><Icon icon={ChevronDown} /></button>}
    </div>
    <div className="bh-message-meta">
      <span className="bh-message-sender" data-direction={direction} title={direction === 'unknown' ? '发送方向未知' : undefined}>
        {direction === 'in' && <Icon icon={ArrowLeft} />}
        {sender}
        {direction === 'out' && <Icon icon={ArrowRight} />}
      </span>
      <MessageReceipt direction={direction} receipt={receipt} />
    </div>
  </div>;
}

function DeleteLayer({name, company, editor, message, draftKeys}: {name: string; company?: boolean; editor: string; message: ExternalRecord; draftKeys: string[]}) {
  const headingId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const session = view.session;
  function close() {
    if (saving) return;
    void closeEditor();
  }
  async function confirm() {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await chrome.runtime.sendMessage(message);
      if (!result?.ok) throw new Error(result?.error || '删除失败');
      for (const key of draftKeys) drafts.delete(key);
      if (view.editor === editor && view.session === session) {
        await closeEditor();
        if (view.session === session) showNotice('已删除「' + name + '」的本地记录');
      }
    } catch (failure) {
      setError(errorText(failure));
      setSaving(false);
    }
  }
  return <dialog className="bh-layer bh-delete-dialog" ref={showEditorDialog} aria-labelledby={headingId} onCancel={event => {event.preventDefault(); close();}}>
    <h3 id={headingId}>删除「{name}」的{company ? '公司' : '职位'}记录？</h3>
    <p>{company ? '将清除这家公司的本地备注及旗下所有 JD 的备注和状态。' : '将清除此 JD 的本地备注和状态。'}后续采集会跳过{company ? '这家公司' : '此 JD'}。已有聊天和 BOSS 上的收藏会保留。</p>
    {error && <p className="bh-status-error" role="alert">{error}</p>}
    <div className="bh-editor-actions">
      <button className="bh-cancel" type="button" autoFocus disabled={saving} onClick={close}>取消</button>
      <button className="bh-confirm-delete" type="button" aria-busy={saving} disabled={saving} onClick={() => void confirm()}>{saving ? <><span className="bh-spinner"><Icon icon={Loader} /></span>正在删除…</> : '确认删除'}</button>
    </div>
  </dialog>;
}

function Job({job, context}: {job: WidgetJob; context: WidgetContext}) {
  const statusPickerId = useId();
  const url = jobURL(job.url);
  const statusKey = editorKey('job-status', job.id);
  const noteKey = editorKey('job-note', job.id);
  const deleteKey = editorKey('job-delete', job.id);
  const status = !job.manual && job.status === 'resume_event' && job.label ? job.label : statusLabel(job.status);
  const statusText = status + (job.manual ? '（手动）' : '');
  const statusDateLabel = formatRelativeStatusDate(job.statusAt);
  const statusOpen = view.editor === statusKey;
  const canEditStatus = !!job.id;
  const noteLabel = job.note ? '编辑 JD 备注' : '添加 JD 备注';
  const openNote = () => openNoteEditor('job-note', job.id, job.note || '');
  function remove() {
    if (view.editor) {showNotice('请先保存或取消正在编辑的内容'); return;}
    activateEditor(deleteKey);
  }
  return <article className={'bh-job' + (job.current ? ' bh-current' : '')} aria-current={job.current ? 'true' : undefined}>
    <div className="bh-job-heading-row">
      <h3 className="bh-job-heading" title={job.title || '待识别 JD'}>{url ? <a className="bh-job-title" href={url} target="_blank" rel="noopener noreferrer">{job.title || '待识别 JD'}</a> : <span className="bh-job-title">{job.title || '待识别 JD'}</span>}</h3>
      {job.favorite && <FavoriteMark kind="job" />}
      <div className="bh-heading-actions">
        <button className="bh-icon-button bh-job-note-edit" type="button" disabled={!job.id} aria-label={noteLabel + '：' + (job.title || '待识别 JD')} title={noteLabel} data-active={view.editor === noteKey} onClick={openNote}><NoteIcon hasNote={!!job.note} /></button>
        <button className="bh-icon-button bh-job-delete" type="button" disabled={!job.id || !job.persisted} aria-label={'删除 ' + (job.title || '待识别 JD')} title="删除职位记录" aria-haspopup="dialog" onClick={remove}>
          <Icon icon={Trash} />
        </button>
      </div>
    </div>
    {job.jobClosed && <span className="bh-job-closed">职位已关闭</span>}
    {job.note && <p className="bh-note-text">{job.note}</p>}
    <div className="bh-job-status-row">
      <button className="bh-job-status" type="button" disabled={!canEditStatus} aria-haspopup={canEditStatus ? 'dialog' : undefined}
        aria-label={canEditStatus ? statusText + '，修改 ' + (job.title || '当前职位') + ' 的状态' : undefined}
        aria-expanded={canEditStatus ? statusOpen : undefined} aria-controls={statusOpen ? statusPickerId : undefined}
        onClick={() => {if (statusOpen) void closeEditor(); else activateEditor(statusKey);}}
        onKeyDown={event => {if (statusOpen && event.key === 'Escape') {event.stopPropagation(); void closeEditor();}}}>{statusText}{canEditStatus && <Icon icon={ChevronDown} />}</button>
      {statusDateLabel && job.statusAt && <time className="bh-job-status-date" dateTime={new Date(job.statusAt).toISOString()}
        title={(job.manual ? '手动设置于 ' : '状态更新于 ') + statusDateFormat.format(job.statusAt)}>{statusDateLabel}</time>}
    </div>
    {statusOpen && <StatusPicker key={view.session} id={statusPickerId} job={job} editor={statusKey} previousStatus={status} dismiss={closeEditor} />}
    {job.latestMessage && <LatestMessage {...job.latestMessage} />}
    {!!job.noteConflicts?.length && <details className="bh-note-history"><summary>合并前的备注（{job.noteConflicts.length}）</summary>{job.noteConflicts.map((note, index) => <p className="bh-note-text" key={index}>{note.text}</p>)}</details>}
    {view.editor === noteKey && <NoteEditor key={noteKey + ':' + view.session} kind="job-note" id={job.id} title={job.title} />}
    {view.editor === deleteKey && <DeleteLayer name={job.title || '待识别 JD'} editor={deleteKey} message={{type: 'DELETE_JOB', account: context.account, jobId: job.id, expectedUpdatedAt: job.updatedAt}} draftKeys={[noteKey]} />}
  </article>;
}

function Widget() {
  const current = useSyncExternalStore(subscribe, getSnapshot);
  const [collapsed, setCollapsed] = useState(() => window.matchMedia?.('(max-width: 650px)').matches ?? false);
  const [openingDashboard, setOpeningDashboard] = useState(false);
  const records = useRef<HTMLDivElement>(null);
  const lastPositionedContext = useRef<WidgetContext | null>(null);
  const {context, data, editor, session, notice, loading} = current;
  const companyId = data?.companyId || '';
  const key = editorKey('company-note', companyId);
  const deleteKey = editorKey('company-delete', companyId);
  const companyName = data?.companyName || context?.companyName || (context ? '公司待识别' : 'BoDesk');
  const companyNoteLabel = data?.companyNote ? '编辑公司备注' : '添加公司备注';
  useLayoutEffect(() => {
    if (!context || collapsed || lastPositionedContext.current === context) return;
    const list = records.current;
    const currentJob = list?.querySelector('.bh-current');
    if (!list || !currentJob) return;
    lastPositionedContext.current = context;
    const viewport = list.getBoundingClientRect();
    const offset = currentJob.getBoundingClientRect().top - viewport.top;
    if (offset < 0 || viewport.height - offset < 120) list.scrollTop += offset - 12;
  }, [collapsed, context, data]);

  function toggleWidget() {
    if (!collapsed && editor) {
      void closeEditor(false);
    }
    setCollapsed(!collapsed);
  }
  async function openDashboard() {
    if (openingDashboard) return;
    setOpeningDashboard(true);
    try {
      const result = await chrome.runtime.sendMessage({type: 'OPEN_DASHBOARD', account: context?.account || lastAccount});
      if (!result?.ok) showNotice(result?.error || '打开 BoDesk 失败');
    } catch {showNotice('扩展连接中断，请刷新页面');}
    finally {setOpeningDashboard(false);}
  }
  return <>
    <div className="bh-widget-header">
      <div className="bh-widget-drag" ref={attachWidgetDragHandle} role="group" tabIndex={0} aria-label="拖动浮窗，或用方向键移动" aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight" title="拖动浮窗"><Icon icon={More} /></div>
      <h2 className="bh-company" hidden={collapsed}>{companyName}{data?.companyFavorite && <FavoriteMark kind="company" />}</h2>
      {context && !data?.companyDeleted && <div className="bh-heading-actions" hidden={collapsed}>
        <button className="bh-icon-button bh-company-note-edit" type="button" disabled={!companyId} aria-label={companyNoteLabel} title={companyNoteLabel} aria-haspopup="dialog" data-active={editor === key} onClick={() => openNoteEditor('company-note', companyId, data?.companyNote || '')}><NoteIcon hasNote={!!data?.companyNote} /></button>
        {data?.companyPersisted && <button className="bh-icon-button bh-company-delete" type="button" aria-label={'删除公司 ' + companyName} title="删除公司记录" aria-haspopup="dialog" onClick={() => {if (editor) showNotice('请先保存或取消正在编辑的内容'); else activateEditor(deleteKey);}}><Icon icon={Trash} /></button>}
      </div>}
      <button className="bh-icon-button bh-widget-toggle" type="button" aria-label={collapsed ? '展开浮窗' : '收起浮窗'} aria-expanded={!collapsed} aria-controls="boss-local-helper-widget-body" onClick={toggleWidget}>{collapsed && <span>BoDesk</span>}<Icon icon={ChevronDown} /></button>
    </div>
    <div id="boss-local-helper-widget-body" className="bh-widget-body" hidden={collapsed}>
      {context && !!data?.companyNote && <div className="bh-company-notes" role="group" aria-label="公司备注"><p className="bh-note-text">{data.companyNote}</p></div>}
      {editor === key && <NoteEditor key={key + ':' + session} kind="company-note" id={companyId} title={companyName} />}
      {context && editor === deleteKey && <DeleteLayer name={companyName} company editor={deleteKey} message={{type: 'DELETE_COMPANY', account: context.account, companyId, expectedNote: data?.companyNote || ''}} draftKeys={[key, ...(data?.jobs || []).map(job => editorKey('job-note', job.id))]} />}
      <div ref={records} className="bh-records">
        {!context && <p className="bh-empty">打开一段对话或职位页，即可查看沟通记录</p>}
        {context && loading && !data && <div className="bh-skeleton-list bh-skeleton-card" aria-hidden="true">
          <span className="bh-skeleton-bar" style={{width: '72%'}} />
          <span className="bh-skeleton-bar" style={{width: '48%'}} />
          <span className="bh-skeleton-bar" style={{width: '88%'}} />
        </div>}
        {context && !!data?.jobs?.length && <section className="bh-jobs" key={context.account + ':' + (data.companyId || data.companyName || '')} aria-label="职位记录">
          {data.jobs.map(job => <Job key={context.account + ':' + job.id} job={job} context={context} />)}
        </section>}
        <p className="bh-notice" role="status" hidden={!notice} data-loading={loading || undefined}>
          {loading && notice && <span className="bh-spinner"><Icon icon={Loader} /></span>}
          {notice}
        </p>
      </div>
      <div className="bh-controls">
        <button className="bh-overview" type="button" aria-busy={openingDashboard} disabled={openingDashboard} onClick={() => void openDashboard()}>
          BoDesk{openingDashboard ? <span className="bh-spinner"><Icon icon={Loader} /></span> : <Icon icon={ArrowUpRight} />}
        </button>
      </div>
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
  if (data.type === 'PAGE_CONTEXT') next = {account: data.account, jobId: data.jobId || '', companyName: data.companyName || '', title: data.title || '', preview: true, ...(typeof data.jobClosed === 'boolean' ? {jobClosed: data.jobClosed} : {})};
  if (data.type === 'SNAPSHOT') {
    const row = (data.rows || []).find((item: ExternalRecord) => item.id === data.selectedId);
    if (row) next = {account: data.account, jobId: row.jobId || '', companyName: row.companyName || '', title: row.jobTitle || ''};
  }
  if (!['PAGE_CONTEXT', 'SNAPSHOT'].includes(data.type) || JSON.stringify(next) === JSON.stringify(view.context)) return;
  renderVersion++;
  editorTrigger = null;
  update({context: next, data: null, editor: null, session: view.session + 1, loading: Boolean(next), notice: next ? '正在读取职位状态…' : ''});
  if (document.body) ensureWidget();
}

window.addEventListener('message', async event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL || event.data.direction !== 'to-extension') return;
  const data = event.data.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'COMMAND_RESULT') {const command = pending.get(data.commandId); if (command) {clearTimeout(command.timer); pending.delete(data.commandId); command.resolve(data);} return;}
  if (!['SNAPSHOT', 'CONVERSATION', 'SYNC_PROGRESS', 'SYNC_ERROR', 'PAGE_CONTEXT', 'FAVORITES', 'COMPANY_FAVORITES'].includes(data.type)) return;
  if (typeof data.account === 'string') lastAccount = data.account;
  chooseContext(data);
  try {
    const result = await chrome.runtime.sendMessage({type: 'INGEST', data});
    if (data.requestId) post({type: 'INGEST_ACK', requestId: data.requestId, account: data.account, runId: data.runId, ok: result?.ok === true, error: result?.error || (!result?.ok ? '本地数据库更新失败' : undefined)});
    if (!document.body) return;
    ensureWidget();
    if (!result?.ok) {showNotice(result?.error || '本地数据库更新失败'); return;}
    if (view.context?.account === data.account && ['SNAPSHOT', 'CONVERSATION', 'PAGE_CONTEXT', 'FAVORITES', 'COMPANY_FAVORITES'].includes(data.type)) await refreshWidget();
  } catch {
    if (data.requestId) post({type: 'INGEST_ACK', requestId: data.requestId, account: data.account, runId: data.runId, ok: false, error: '扩展连接中断，请刷新页面'});
    showNotice('扩展连接中断，请刷新页面');
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'FAVORITES_CHANGED') {
    if (view.context?.account === message.account) void refreshWidget();
    return;
  }
  if (message.type === 'BUILD_RELOAD_READY') {
    sendResponse({ready: !view.editor && ![...drafts.values()].some(draft => draft.value !== draft.baseValue)});
    return;
  }
  if (message.type === 'ACCOUNT_INFO') {sendResponse({account: lastAccount}); return;}
  if (!['SYNC', 'STOP_SYNC'].includes(message.type)) return;
  const commandId = crypto.randomUUID();
  const timer = setTimeout(() => {pending.delete(commandId); sendResponse({ok: false, error: '网页未响应，请确认聊天页已加载并刷新'});}, 12000);
  pending.set(commandId, {timer, resolve: sendResponse});
  post({type: message.type, commandId, account: message.account, runId: message.runId, ...(message.type === 'SYNC' ? {intervalSeconds: message.intervalSeconds, activityWindow: message.activityWindow} : {})});
  return true;
});
document.addEventListener('visibilitychange', () => {if (!document.hidden && view.context && !view.editor) void refreshWidget();});
if (document.body) ensureWidget();
else document.addEventListener('DOMContentLoaded', () => {ensureWidget(); void refreshWidget();}, {once: true});
post({type: 'SNAPSHOT'});
