import {Fragment, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {JobBoard} from './job-board.tsx';
import type {DatabaseSnapshot, ExternalRecord} from './types.ts';
import {syncInterval, syncIntervalSeconds} from './sync-interval.ts';
import './typography.css';
import '../dashboard.css';

const text = (value: unknown, fallback = '') => value == null || value === '' ? fallback : String(value);
const describe = (value: unknown) => value == null || value === '' ? '未提供' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
const records = (value: unknown): ExternalRecord[] => Array.isArray(value) ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : [];
const isBoardView = () => location.hash === '#board';
function formatTime(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return '未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleString('zh-CN', {hour12: false});
}
const names: Record<string, string> = {running: '正在运行', complete: '本次任务结束', processed: '已处理', total: '本次会话数', failed: '失败数', updatedAt: '更新时间', startedAt: '开始时间', finishedAt: '结束时间', coverage: '覆盖范围', message: '说明', runId: '任务标识'};

function Dashboard() {
  const [db, setDb] = useState<DatabaseSnapshot | null>(null);
  const [showBoard, setShowBoard] = useState(isBoardView);
  const [busy, setBusy] = useState(true);
  const [syncRequested, setSyncRequested] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [intervalDraft, setIntervalDraft] = useState<{account: string; seconds: number} | null>(null);
  const [feedback, setFeedback] = useState({message: '正在读取本地记录…', error: false});
  const state = useRef({account: null as string | null, busy: true, stopping: false, syncRequested: false, db: null as DatabaseSnapshot | null, mounted: true, generation: 0});
  const notify = (message: string, error = false) => {if (state.current.mounted) setFeedback({message, error});};
  const markBusy = (value: boolean) => {state.current.busy = value; if (state.current.mounted) setBusy(value);};
  async function request(message: ExternalRecord, account = state.current.account) {
    if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('请从已加载的 Chrome 扩展中打开此页面。');
    if (['DB_GET', 'EXPORT', 'SYNC', 'STOP_SYNC', 'SET_SYNC_INTERVAL'].includes(message.type) && (message.type !== 'DB_GET' || account !== null)) message = {...message, account};
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {const reason = response?.error?.message || response?.error || response?.message; throw new Error(typeof reason === 'string' ? reason : '扩展未返回成功结果，请稍后重试。');}
    if (account && ['DB_GET', 'EXPORT'].includes(message.type) && response.data && response.data.account !== account) throw new Error('返回数据的账号与所选账号不一致，请重新选择账号后重试。');
    return response;
  }
  async function load(account = state.current.account) {
    const generation = ++state.current.generation;
    const response = await request({type: 'DB_GET'}, account);
    const data = response.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('本地数据格式异常，请刷新重试。');
    if (!state.current.mounted || generation !== state.current.generation) return;
    const nextAccount: string | null = data.account ?? null;
    const accounts = new Set<string>(Array.isArray(data.accounts) ? data.accounts.filter((value: unknown) => typeof value === 'string' && value) : []);
    if (nextAccount) accounts.add(nextAccount);
    const snapshot: DatabaseSnapshot = {
      account: nextAccount,
      accounts: [...accounts],
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
  const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
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
        notify(Object.hasOwn(message, 'status') ? '已保存状态。' : '已保存备注。');
      } catch (error) {notify('已保存，刷新记录失败：' + errorText(error), true);}
    } finally {markBusy(false);}
  }
  async function sync() {
    await action(async () => {
      state.current.syncRequested = true; setSyncRequested(true); notify('正在请求采集…');
      try {await request({type: 'SYNC'}); await load(); if (!state.current.stopping) notify('已发送采集请求。');}
      finally {state.current.syncRequested = false; setSyncRequested(false);}
    });
  }
  async function stop() {
    if (state.current.stopping || !(state.current.syncRequested || (!state.current.busy && state.current.db?.sync.running))) return;
    state.current.stopping = true; setStopping(true); notify('正在请求停止采集…');
    try {await request({type: 'STOP_SYNC'}); await load(); notify('已发送停止请求，已保存的记录仍可查看。');}
    catch (error) {notify('停止或刷新失败：' + errorText(error) + '。请刷新确认同步状态。', true);}
    finally {state.current.stopping = false; setStopping(false);}
  }
  async function selectAccount(account: string) {
    if (!account || state.current.syncRequested || account === state.current.account) return;
    await action(async () => {notify('正在切换账号并读取记录…'); await request({type: 'SELECT_ACCOUNT', account}); await load(account); setIntervalDraft(null); notify('已切换账号，当前操作与导出均使用所选账号。');});
  }
  async function saveInterval() {
    const account = state.current.account;
    if (!intervalDraft || intervalDraft.account !== account) return;
    const seconds = intervalDraft.seconds;
    await action(async () => {
      await request({type: 'SET_SYNC_INTERVAL', intervalSeconds: seconds}, account);
      const snapshot = state.current.db;
      if (snapshot?.account === account) {
        const updated = {...snapshot, syncIntervalSeconds: seconds};
        state.current.db = updated;
        if (state.current.mounted) setDb(updated);
      }
      setIntervalDraft(null);
      notify('已保存请求间隔，下一轮采集生效。');
    });
  }
  async function exportData() {
    await action(async () => {
      const response = await request({type: 'EXPORT'});
      if (!response.data || typeof response.data !== 'object') throw new Error('导出失败：未收到有效数据。');
      const url = URL.createObjectURL(new Blob([JSON.stringify(response.data, null, 2)], {type: 'application/json;charset=utf-8'}));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = '求职记录-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'; document.body.append(anchor);
      try {anchor.click();} finally {anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);}
      notify('已发起 JSON 文件下载，请在浏览器下载列表中确认。');
    });
  }
  useEffect(() => {
    state.current.mounted = true;
    const changeView = () => setShowBoard(isBoardView());
    window.addEventListener('hashchange', changeView);
    const account = new URLSearchParams(location.search).get('account');
    void load(account || undefined).then(() => notify('')).catch(error => notify(errorText(error), true)).finally(() => markBusy(false));
    const timer = setInterval(() => {
      const current = state.current;
      if (current.busy || current.stopping || current.syncRequested || !current.db?.sync.running || document.hidden) return;
      void action(async () => {await load();});
    }, 3000);
    return () => {state.current.mounted = false; clearInterval(timer); window.removeEventListener('hashchange', changeView);};
  }, []);
  const title = showBoard ? 'JD 看板' : '采集与导出';
  useEffect(() => {document.title = title;}, [title]);
  const current = db?.sync || {};
  const selectedInterval = intervalDraft && intervalDraft.account === db?.account ? intervalDraft.seconds : db?.syncIntervalSeconds ?? syncInterval.default;
  const entries = Object.entries(current);
  const {processed, total, failed} = current;
  const progress = typeof processed === 'number' && Number.isFinite(processed) && processed >= 0
    && typeof total === 'number' && Number.isFinite(total) && total > 0
    ? {value: Math.min(processed, total), max: total} : null;
  const syncState = current.running ? '采集中' : current.complete ? '本次采集已结束' : entries.length ? '当前未采集' : '暂无采集记录';

  const accountPicker = <div className="account-picker">
    <label htmlFor="account-select">账号</label>
    <select id="account-select" disabled={busy || stopping || syncRequested || !db?.accounts.length} value={db?.account || ''} onChange={event => void selectAccount(event.target.value)}>
      {!db?.account && <option value="">{db ? '暂无可用账号' : '正在读取账号…'}</option>}
      {db?.accounts.map(account => <option key={account} value={account}>{account}</option>)}
    </select>
  </div>;

  return <main className={showBoard ? 'shell board-shell' : 'shell'}>
    <nav className="dashboard-views" aria-label="记录视图">
      <a href="#collection" aria-current={showBoard ? undefined : 'page'}>采集与导出</a>
      <a href="#board" aria-current={showBoard ? 'page' : undefined}>JD 看板</a>
    </nav>
    <header className="page-header">
      <h1 id="dashboard-title">{title}</h1>
      <div className="page-actions">
        {showBoard && accountPicker}
        <button id="refresh" className="button" type="button" disabled={busy || stopping} onClick={() => void action(async () => {await load(); notify('已刷新本地数据。');})}>刷新记录</button>
      </div>
    </header>
    <p id="feedback" className={'feedback' + (feedback.error ? ' error' : '')} role={feedback.error ? 'alert' : 'status'} aria-live="polite" aria-atomic="true">{feedback.message}</p>
    {showBoard ? <JobBoard key={db?.account} snapshot={db} busy={busy} onSave={saveBoardEdit} /> : <div className="workspace">
      <section className="account-panel" aria-labelledby="records-title" aria-busy={busy}>
        <h2 id="records-title">本地记录</h2>
        {accountPicker}
        <dl className="local-count"><dt>已记录对话</dt><dd id="conversation-count">{db ? db.conversations.length : '—'}</dd></dl>
        <button id="export" className="button export" type="button" disabled={busy || stopping || !db} onClick={() => void exportData()}>导出 JSON</button>
      </section>

      <section className="coverage" aria-labelledby="coverage-title" aria-busy={busy} id="sync-panel">
        <div className="section-heading">
          <h2 id="coverage-title">采集进度</h2>
          <span id="sync-state" className="sync-state" data-running={!!current.running}>{syncState}</span>
        </div>
        <div id="sync-progress" className="progress-report">
          <dl className="progress-counts">
            <div><dt>本次已处理</dt><dd>{text(processed, '—')}{total != null && <span> / {total}</span>}</dd></div>
            <div><dt>失败</dt><dd className={failed && failed > 0 ? 'failed' : undefined}>{text(failed, '—')}</dd></div>
          </dl>
          {progress && <progress aria-label="本次会话处理进度" {...progress} />}
          {current.updatedAt != null && <p>更新时间 {formatTime(current.updatedAt)}</p>}
        </div>
        {current.message && <p className="coverage-note">{describe(current.message)}</p>}
        <div className="interval-setting">
          <div className="interval-heading">
            <label htmlFor="sync-interval">采集请求间隔</label>
            <output htmlFor="sync-interval">{selectedInterval} 秒</output>
          </div>
          <input id="sync-interval" type="range" min={syncInterval.min} max={syncInterval.max} step={1} value={selectedInterval}
            aria-valuetext={selectedInterval + ' 秒'} aria-describedby="interval-scope"
            disabled={busy || stopping || !db?.account} onChange={event => {if (db?.account) setIntervalDraft({account: db.account, seconds: event.target.valueAsNumber});}} />
          <div className="interval-limits" aria-hidden="true"><span>{syncInterval.min} 秒</span><span>{syncInterval.max} 秒</span></div>
          <div className="interval-footer">
            <span id="interval-scope" hidden>按账号保存，下次采集生效。</span>
            <button className="button" id="save-sync-interval" type="button" disabled={busy || stopping || !db?.account || selectedInterval === db.syncIntervalSeconds} onClick={() => void saveInterval()}>保存间隔</button>
          </div>
        </div>
        <div className="actions">
          <button id="sync" className="button primary" type="button" disabled={busy || stopping || !db || current.running} onClick={() => void sync()}>{syncRequested ? '正在请求采集…' : '更新采集'}</button>
          <button id="stop-sync" className="button" type="button" disabled={stopping || !(syncRequested || (!busy && current.running))} onClick={() => void stop()}>{stopping ? '正在停止…' : '停止采集'}</button>
        </div>
        <details id="sync-details">
          <summary>查看采集详情</summary>
          <dl id="sync-metadata" className="metadata">{entries.length ? entries.map(([key, value]) => <Fragment key={key}><dt>{names[key] || key}</dt><dd>{/At$/.test(key) ? formatTime(value) : describe(value)}</dd></Fragment>) : <><dt>覆盖情况</dt><dd>暂无采集详情。</dd></>}</dl>
        </details>
      </section>
    </div>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<Dashboard />);
