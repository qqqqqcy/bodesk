import {Fragment, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {DatabaseSnapshot, ExternalRecord} from './types.ts';
import '../dashboard.css';

const text = (value: unknown, fallback = '') => value == null || value === '' ? fallback : String(value);
const describe = (value: unknown) => value == null || value === '' ? '未提供' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
function formatTime(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return '未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleString('zh-CN', {hour12: false});
}
const names: Record<string, string> = {running: '正在运行', complete: '本次任务结束', processed: '已处理', total: '本次会话数', failed: '失败数', updatedAt: '更新时间', startedAt: '开始时间', finishedAt: '结束时间', coverage: '覆盖范围', message: '说明', runId: '任务标识'};

function Dashboard() {
  const [db, setDb] = useState<DatabaseSnapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [syncRequested, setSyncRequested] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [feedback, setFeedback] = useState({message: '正在读取本地记录…', error: false});
  const state = useRef({account: null as string | null, busy: true, stopping: false, syncRequested: false, db: null as DatabaseSnapshot | null, mounted: true, generation: 0});
  const notify = (message: string, error = false) => {if (state.current.mounted) setFeedback({message, error});};
  const markBusy = (value: boolean) => {state.current.busy = value; if (state.current.mounted) setBusy(value);};
  async function request(message: ExternalRecord, account = state.current.account) {
    if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('请从已加载的 Chrome 扩展中打开此页面。');
    if (['DB_GET', 'EXPORT', 'SYNC', 'STOP_SYNC'].includes(message.type) && (message.type !== 'DB_GET' || account !== null)) message = {...message, account};
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
    const snapshot: DatabaseSnapshot = {account: nextAccount, accounts: [...accounts], conversations: Array.isArray(data.conversations) ? data.conversations.filter((value: unknown) => value && typeof value === 'object') : [], sync: data.sync && typeof data.sync === 'object' ? data.sync : {}};
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
  async function sync() {
    await action(async () => {
      state.current.syncRequested = true; setSyncRequested(true); notify('正在请求更新…');
      try {await request({type: 'SYNC'}); await load(); if (!state.current.stopping) notify('更新请求已受理，请查看同步进度。');}
      finally {state.current.syncRequested = false; setSyncRequested(false);}
    });
  }
  async function stop() {
    if (state.current.stopping || !(state.current.syncRequested || (!state.current.busy && state.current.db?.sync.running))) return;
    state.current.stopping = true; setStopping(true); notify('正在请求停止同步…');
    try {await request({type: 'STOP_SYNC'}); await load(); notify('已发送停止请求，已保存的记录仍可查看。');}
    catch (error) {notify('停止或刷新失败：' + errorText(error) + '。请刷新确认同步状态。', true);}
    finally {state.current.stopping = false; setStopping(false);}
  }
  async function selectAccount(account: string) {
    if (!account || state.current.syncRequested || account === state.current.account) return;
    await action(async () => {notify('正在切换账号并读取记录…'); await request({type: 'SELECT_ACCOUNT', account}); await load(account); notify('已切换账号，当前操作与导出均使用所选账号。');});
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
    const account = new URLSearchParams(location.search).get('account');
    void load(account || undefined).then(() => notify('已载入本地记录。')).catch(error => notify(errorText(error), true)).finally(() => markBusy(false));
    const timer = setInterval(() => {
      const current = state.current;
      if (current.busy || current.stopping || current.syncRequested || !current.db?.sync.running || document.hidden) return;
      void action(async () => {await load();});
    }, 3000);
    return () => {state.current.mounted = false; clearInterval(timer);};
  }, []);
  const current = db?.sync || {};
  const entries = Object.entries(current);
  return <main className="shell">
    <header className="page-header"><div><p className="eyebrow">求职记录</p><h1>采集与导出</h1><p className="subtitle">更新聊天记录，查看采集进度或导出本地数据。</p></div>
      <div className="actions"><button id="refresh" type="button" disabled={busy || stopping} onClick={() => void action(async () => {await load(); notify('已刷新本地数据。');})}>刷新</button><button id="export" type="button" disabled={busy || stopping || !db} onClick={() => void exportData()}>导出 JSON</button><button id="sync" className="primary" type="button" disabled={busy || stopping || !db || current.running} onClick={() => void sync()}>{syncRequested ? '正在请求更新…' : '更新采集'}</button><button id="stop-sync" type="button" disabled={stopping || !(syncRequested || (!busy && current.running))} onClick={() => void stop()}>{stopping ? '正在停止…' : '停止同步'}</button></div>
    </header>
    <p id="feedback" className={'feedback' + (feedback.error ? ' error' : '')} role={feedback.error ? 'alert' : 'status'} aria-live="polite" aria-atomic="true">{feedback.message}</p>
    <section className="stat" aria-label="本地记录概览"><span>已记录对话</span><strong id="conversation-count">{db ? db.conversations.length : '—'}</strong></section>
    <section className="coverage panel" aria-labelledby="coverage-title" aria-busy={busy} id="sync-panel">
      <div className="section-heading"><h2 id="coverage-title">采集进度</h2><span id="sync-state" className="badge">{current.running ? '同步进行中' : current.complete ? '本次任务结束 · 覆盖有限' : entries.length ? '当前未在同步 · 覆盖待核实' : '暂无同步覆盖信息'}</span></div>
      <div className="account-picker"><label htmlFor="account-select">查看账号</label><select id="account-select" disabled={busy || stopping || syncRequested || !db?.accounts.length} value={db?.account || ''} onChange={event => void selectAccount(event.target.value)}>{!db?.account && <option value="">{db ? '请选择账号' : '正在读取账号…'}</option>}{db?.accounts.map(account => <option key={account} value={account}>{account}</option>)}</select></div>
      <p id="account">当前账号：{db ? text(db.account, '未提供账号标识') : '等待本地数据'}</p>
      <p id="sync-progress">本次已处理 {text(current.processed, '—')} / {text(current.total, '—')} · 失败 {text(current.failed, '—')} · 更新于 {formatTime(current.updatedAt)}</p>
      <p id="sync-message">覆盖说明：{describe(current.coverage)}{current.message ? '；' + describe(current.message) : ''}</p>
      <p>采集范围取决于聊天页当前已加载的会话，不能保证覆盖全部记录。</p>
      <details id="sync-details"><summary>查看同步信息</summary><dl id="sync-metadata" className="metadata">{entries.length ? entries.map(([key, value]) => <Fragment key={key}><dt>{names[key] || key}</dt><dd>{/At$/.test(key) ? formatTime(value) : describe(value)}</dd></Fragment>) : <><dt>覆盖情况</dt><dd>尚无同步元数据，无法确认采集范围与历史完整性。</dd></>}</dl></details>
    </section>
    <footer>记录保存在扩展本地。导出文件可能包含隐私信息，请妥善保管。</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Dashboard />);
