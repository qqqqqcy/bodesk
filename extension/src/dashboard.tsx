import {useEffect, useRef, useState} from 'react';
import type {CSSProperties} from 'react';
import {createRoot} from 'react-dom/client';
import {Gear, Loader} from 'reicon';
import {ActivityRange, boardActivityWindow, JobBoard, useBoardPreferences} from './job-board.tsx';
import {DashboardSelect} from './dashboard-select.tsx';
import {Icon} from './icon.tsx';
import {backupText} from './backup.ts';
import type {DatabaseSnapshot, ExternalRecord} from './types.ts';
import {syncInterval, syncIntervalSeconds} from './sync-interval.ts';
import './typography.css';
import '../dashboard.css';

const text = (value: unknown, fallback = '') => value == null || value === '' ? fallback : String(value);
function describe(value: unknown) {
  if (value == null || value === '') return '未提供';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}
const records = (value: unknown): ExternalRecord[] => Array.isArray(value) ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : [];
function formatTime(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return '未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleString('zh-CN', {hour12: false});
}
const names: Record<string, string> = {running: '运行中', complete: '本次采集完成', processed: '已处理会话', total: '总会话数', failed: '失败数', updatedAt: '更新时间', startedAt: '开始时间', finishedAt: '结束时间', coverage: '覆盖范围', message: '说明', runId: '任务标识'};

function Dashboard() {
  const [db, setDb] = useState<DatabaseSnapshot | null>(null);
  const board = useBoardPreferences();
  const importInput = useRef<HTMLInputElement>(null);
  const intervalInput = useRef<HTMLInputElement>(null);
  const intervalWrite = useRef<Promise<boolean> | null>(null);
  const [busy, setBusy] = useState(true);
  const [syncRequested, setSyncRequested] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<'import' | 'export' | 'account' | null>(null);
  const [savingInterval, setSavingInterval] = useState(false);
  const [intervalDraft, setIntervalDraft] = useState<{account: string; seconds: number} | null>(null);
  const [feedback, setFeedback] = useState<{message: string; error: boolean; pending?: boolean}>({message: '正在读取本地记录…', error: false, pending: true});
  const state = useRef({account: new URLSearchParams(location.search).get('account') || null, busy: true, stopping: false, syncRequested: false, db: null as DatabaseSnapshot | null, mounted: true, generation: 0, dirty: false});
  const notify = (message: string, error = false, pending = false) => {if (state.current.mounted) setFeedback({message, error, pending});};
  const markBusy = (value: boolean) => {state.current.busy = value; if (state.current.mounted) setBusy(value);};
  async function request(message: ExternalRecord, account = state.current.account) {
    if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('请在已加载的 BoDesk 扩展中打开此页面');
    if (['DB_GET', 'EXPORT', 'SYNC', 'STOP_SYNC', 'SET_SYNC_INTERVAL'].includes(message.type) && (message.type !== 'DB_GET' || account !== null)) message = {...message, account};
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {const reason = response?.error?.message || response?.error || response?.message; throw new Error(typeof reason === 'string' ? reason : '扩展未返回有效结果，请稍后重试');}
    if (account && ['DB_GET', 'EXPORT'].includes(message.type) && response.data && response.data.account !== account) throw new Error('返回数据的账号与所选账号不一致，请重新选择账号后重试');
    return response;
  }
  async function load(account = state.current.account) {
    const generation = ++state.current.generation;
    const response = await request({type: 'DB_GET'}, account);
    const data = response.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('本地数据格式异常，请刷新重试');
    if (!state.current.mounted || generation !== state.current.generation) return;
    const nextAccount: string | null = data.account ?? null;
    const accounts = new Set<string>(Array.isArray(data.accounts) ? data.accounts.filter((value: unknown) => typeof value === 'string' && value) : []);
    if (nextAccount) accounts.add(nextAccount);
    const snapshot: DatabaseSnapshot = {
      account: nextAccount,
      accounts: [...accounts],
      accountNames: Object.fromEntries([...accounts].flatMap(id => {
        const name = data.accountNames?.[id];
        return typeof name === 'string' && name.trim() ? [[id, name.trim()]] : [];
      })),
      conversations: records(data.conversations),
      jobs: records(data.jobs),
      companies: records(data.companies),
      sync: data.sync && typeof data.sync === 'object' ? data.sync : {},
      syncIntervalSeconds: syncIntervalSeconds(data.syncIntervalSeconds),
    };
    state.current.account = nextAccount;
    state.current.db = snapshot;
    setDb(snapshot);
  }
  const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
  async function action(work: () => Promise<void>) {
    if (state.current.busy || state.current.stopping) return;
    markBusy(true);
    try {await work();} catch (error) {notify(errorText(error), true);} finally {markBusy(false);}
  }
  async function saveBoardEdit(message: ExternalRecord) {
    const account = state.current.account;
    if (!account || message.account !== account) throw new Error('所选账号已更改，请重新打开编辑');
    if (state.current.busy || state.current.stopping) throw new Error('正在读取本地记录，请稍后重试');
    markBusy(true);
    try {
      await request(message, account);
      try {
        await load(account);
        notify(Object.hasOwn(message, 'status') ? '已保存状态' : '已保存备注');
      } catch (error) {notify('已保存，刷新记录失败：' + errorText(error), true);}
    } finally {markBusy(false);}
  }
  async function sync() {
    await action(async () => {
      if (intervalWrite.current && !await intervalWrite.current) return;
      state.current.syncRequested = true; setSyncRequested(true); notify('');
      try {await request({type: 'SYNC', activityWindow: boardActivityWindow(board.preferences, Date.now())}); await load(); if (!state.current.stopping) notify('');}
      finally {state.current.syncRequested = false; setSyncRequested(false);}
    });
  }
  async function stop() {
    if (state.current.stopping || !(state.current.syncRequested || (!state.current.busy && state.current.db?.sync.running))) return;
    state.current.stopping = true; setStopping(true); notify('正在请求停止采集…', false, true);
    try {await request({type: 'STOP_SYNC'}); await load(); notify('已发送停止请求，已保存的记录仍可查看');}
    catch (error) {notify('停止采集失败：' + errorText(error), true);}
    finally {state.current.stopping = false; setStopping(false);}
  }
  async function selectAccount(account: string) {
    if (!account || state.current.syncRequested || account === state.current.account) return;
    await action(async () => {
      if (state.current.mounted) setPendingAction('account');
      try {
        await intervalWrite.current;
        notify('正在切换账号并读取记录…', false, true);
        await request({type: 'SELECT_ACCOUNT', account});
        await load(account);
        setIntervalDraft(null);
        notify('已切换账号');
      } finally {if (state.current.mounted) setPendingAction(null);}
    });
  }
  function saveInterval(seconds: number) {
    const account = state.current.account;
    if (!account) return;
    if (state.current.mounted) setSavingInterval(true);
    const saving: Promise<boolean> = Promise.resolve(intervalWrite.current).then(async () => {
      try {
        const before = state.current.db;
        if (before?.account !== account || before.syncIntervalSeconds !== seconds) {
          await request({type: 'SET_SYNC_INTERVAL', intervalSeconds: seconds}, account);
          const snapshot = state.current.db;
          if (snapshot?.account === account) {
            const updated = {...snapshot, syncIntervalSeconds: seconds};
            state.current.db = updated;
            if (state.current.mounted) setDb(updated);
          }
        }
        return true;
      } catch (error) {
        notify('保存请求间隔失败：' + errorText(error), true);
        return false;
      } finally {
        if (intervalWrite.current === saving) {
          intervalWrite.current = null;
          if (state.current.mounted) {
            setSavingInterval(false);
            setIntervalDraft(draft => draft?.account === account && draft.seconds === seconds ? null : draft);
          }
        }
      }
    });
    intervalWrite.current = saving;
  }
  async function exportData() {
    await action(async () => {
      if (state.current.mounted) setPendingAction('export');
      try {
        const response = await request({type: 'EXPORT'});
        if (!response.data || typeof response.data !== 'object') throw new Error('导出失败：未收到有效数据');
        const url = URL.createObjectURL(new Blob([JSON.stringify(response.data, null, 2)], {type: 'application/json;charset=utf-8'}));
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = 'BoDesk-备份-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'; document.body.append(anchor);
        try {anchor.click();} finally {anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);}
        notify('已开始导出 JSON，请在浏览器下载列表查看');
      } finally {if (state.current.mounted) setPendingAction(null);}
    });
  }
  async function importData(file: File) {
    await action(async () => {
      if (state.current.mounted) setPendingAction('import');
      try {
        const response = await request({type: 'IMPORT', json: await backupText(file)});
        await load(response.account);
        notify('已导入 ' + response.added + ' 条记录，跳过 ' + response.skipped + ' 条已有记录');
      } finally {if (state.current.mounted) setPendingAction(null);}
    });
  }
  useEffect(() => {
    state.current.mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    let active = true;
    const schedule = () => {
      if (!active || timer !== undefined || loading || document.hidden) return;
      timer = setTimeout(async () => {
        timer = undefined;
        const current = state.current;
        if (document.hidden || !current.dirty) return;
        if (current.busy || current.stopping) {schedule(); return;}
        loading = true;
        current.dirty = false;
        const firstRead = !current.db;
        try {await load(); if (firstRead) notify('');}
        catch (error) {notify(errorText(error), true);}
        finally {loading = false; if (current.dirty) schedule();}
      }, 180);
    };
    const refresh = () => {state.current.dirty = true; schedule();};
    const onDataChange = (message: ExternalRecord) => {if (message?.type === 'DASHBOARD_CHANGED') refresh();};
    const slider = intervalInput.current;
    const commitInterval = () => {if (slider && !slider.disabled) saveInterval(slider.valueAsNumber);};
    slider?.addEventListener('change', commitInterval);
    globalThis.chrome?.runtime?.onMessage?.addListener(onDataChange);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    void load().then(() => notify('')).catch(error => notify(errorText(error), true)).finally(() => {markBusy(false); if (state.current.dirty) schedule();});
    const progressTimer = setInterval(() => {if (state.current.db?.sync.running) refresh();}, 3000);
    return () => {
      active = false;
      state.current.mounted = false;
      clearTimeout(timer);
      clearInterval(progressTimer);
      slider?.removeEventListener('change', commitInterval);
      globalThis.chrome?.runtime?.onMessage?.removeListener?.(onDataChange);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  const now = Date.now();
  const activityWindow = boardActivityWindow(board.preferences, now);
  const current = db?.sync || {};
  const selectedInterval = intervalDraft && intervalDraft.account === db?.account ? intervalDraft.seconds : db?.syncIntervalSeconds ?? syncInterval.default;
  const intervalPosition = (selectedInterval - syncInterval.min) / (syncInterval.max - syncInterval.min) * 100 + '%';
  const entries = Object.entries(current).filter(([key]) => key !== 'activityWindow' && key !== 'message');
  const {processed, total} = current;
  const progress = current.running && typeof processed === 'number' && Number.isFinite(processed) && processed >= 0
    && typeof total === 'number' && Number.isFinite(total) && total > 0
    ? {value: Math.min(processed, total), max: total} : null;
  const collecting = syncRequested || Boolean(current.running);

  const accountPicker = <div className="account-picker">
    <label htmlFor="account-select">账号</label>
    <DashboardSelect id="account-select" label="账号" disabled={busy || stopping || syncRequested} value={db?.account || ''}
      placeholder={db ? '暂无可用账号' : '正在读取账号…'} onChange={account => void selectAccount(account)}
      options={db?.accounts.map((account, index) => {
        const name = db.accountNames[account];
        const duplicate = name && db.accounts.some(other => other !== account && db.accountNames[other] === name);
        return {value: account, label: name ? name + (duplicate ? '（账号 ' + (index + 1) + '）' : '') : '未识别名称的账号 ' + (index + 1)};
      }) ?? []} />
  </div>;

  return <main className="shell">
    <header className="page-header">
      <h1 id="dashboard-title">JD 看板</h1>
      <div className="page-actions">
        {accountPicker}
        <div className="file-actions">
          <input ref={importInput} type="file" id="import-file" accept=".json,application/json" hidden onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importData(file);
          }} />
          <button id="import" className="button" type="button" aria-busy={pendingAction === 'import'} disabled={busy || stopping} onClick={() => importInput.current?.click()}>
            {pendingAction === 'import' ? <><span className="bh-spinner"><Icon icon={Loader} /></span>导入中…</> : '导入 JSON'}
          </button>
          <button id="export" className="button" type="button" aria-busy={pendingAction === 'export'} disabled={busy || stopping || !db?.account} onClick={() => void exportData()}>
            {pendingAction === 'export' ? <><span className="bh-spinner"><Icon icon={Loader} /></span>导出中…</> : '导出 JSON'}
          </button>
        </div>
      </div>
    </header>
    <p id="feedback" className={'feedback' + (feedback.error ? ' error' : '')} data-pending={feedback.pending || undefined} role={feedback.error ? 'alert' : 'status'} aria-live="polite" aria-atomic="true">
      {feedback.pending && feedback.message && <span className="bh-spinner"><Icon icon={Loader} /></span>}
      {feedback.message}
    </p>
    <section className="coverage" aria-label="采集" id="sync-panel">
      <div className="sync-toolbar">
        <ActivityRange start={board.preferences.range} end={board.preferences.rangeEnd} now={now} onChange={board.updateRange} />
        <div className="sync-actions">
          <button id="sync" className="button primary" type="button" aria-busy={collecting} disabled={busy || stopping || !db?.account || collecting} onClick={() => void sync()}>
            {collecting ? <><span className="bh-spinner"><Icon icon={Loader} /></span>采集中</> : activityWindow ? '采集所选范围' : '采集全部已加载会话'}
          </button>
          {(collecting || stopping) && <button id="stop-sync" className="button" type="button" aria-busy={stopping} disabled={stopping || !(syncRequested || (!busy && current.running))} onClick={() => void stop()}>
            {stopping ? <><span className="bh-spinner"><Icon icon={Loader} /></span>正在停止…</> : '停止采集'}
          </button>}
          <button className="sync-details-toggle" type="button" aria-label="采集设置与详情" title="采集设置与详情" aria-expanded={detailsOpen} aria-controls="sync-details"
            onClick={() => setDetailsOpen(open => !open)}><Icon icon={Gear} /></button>
        </div>
      </div>
      <div id="sync-details" hidden={!detailsOpen}>
        <div className="sync-details-inner">
          <dl id="sync-metadata" className="metadata">
            <div className="sync-field">
              <dt><label htmlFor="sync-interval">采集请求间隔</label></dt>
              <dd className="interval-setting" data-pending={savingInterval || undefined}>
                <output htmlFor="sync-interval">{selectedInterval} 秒</output>
                <div className="board-range-control interval-range" style={{'--range-end': '0%', '--range-start': intervalPosition} as CSSProperties}>
                  <input ref={intervalInput} id="sync-interval" type="range" min={syncInterval.min} max={syncInterval.max} step={1} value={selectedInterval}
                    aria-valuetext={selectedInterval + ' 秒'} aria-describedby="interval-scope"
                    disabled={busy || stopping || !db?.account} onChange={event => {if (db?.account) setIntervalDraft({account: db.account, seconds: event.target.valueAsNumber});}} />
                  <div className="board-range-rail" aria-hidden="true">
                    <span className="board-range-selection" />
                    <span className="board-range-thumb board-range-thumb-start" />
                  </div>
                </div>
                <span id="interval-scope" hidden>自动保存到当前账号，下次采集生效</span>
              </dd>
            </div>
            {current.message && <div className="sync-field"><dt>采集结果</dt><dd className="coverage-note" role="status">{describe(current.message)}</dd></div>}
            <div className="sync-field" id="conversation-count"><dt>已记录对话</dt><dd>{db?.conversations.length ?? '—'}</dd></div>
            {progress && <div className="sync-field"><dt>采集进度</dt><dd className="sync-progress"><progress aria-label="本次会话处理进度" {...progress} /><span>{progress.value} / {progress.max}</span></dd></div>}
            {entries.length ? entries.map(([key, value]) => <div className="sync-field" key={key}><dt>{names[key] || key}</dt><dd>{/At$/.test(key) ? formatTime(value) : describe(value)}</dd></div>)
              : <div className="sync-field"><dt>覆盖情况</dt><dd>暂无采集详情</dd></div>}
          </dl>
        </div>
      </div>
    </section>
    <JobBoard key={db?.account} snapshot={db} busy={busy} onSave={saveBoardEdit} activityWindow={activityWindow} now={now} board={board} />
  </main>;
}

createRoot(document.getElementById('root')!).render(<Dashboard />);
