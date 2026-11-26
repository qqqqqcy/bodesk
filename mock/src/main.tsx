import {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {api, errorText} from './api.ts';
import {Chat} from './Chat.tsx';
import {Jobs} from './Jobs.tsx';
import type {MockConfig, RequestEntry} from './types.ts';
import type {ExternalRecord} from '../../extension/src/types.ts';
import './styles.css';
import '../../extension/src/typography.css';
import '../../extension/content.css';

const bridgeHint = '未检测到扩展。请加载或重新加载项目根目录下的 extension，然后刷新此页。';
function App() {
  const [config, setConfig] = useState<MockConfig | null>(null);
  const [scenario, setScenario] = useState('normal');
  const [account, setAccount] = useState('alpha');
  const [notice, setNotice] = useState('');
  const [bridge, setBridge] = useState<ExternalRecord[]>([]);
  const [bridgeStatus, setBridgeStatus] = useState('等待扩展连接');
  const [diagnostics, setDiagnostics] = useState(false);
  const [requests, setRequests] = useState<RequestEntry[]>([]);
  useEffect(() => {
    let active = true;
    void api<MockConfig>('/__mock/state').then(result => {
      if (!active) return;
      window._PAGE = {uid: result.user.userId};
      document.body.__vue__ = {$options: {name: 'App'}, $store: {state: {userInfo: result.user}}};
      setConfig(result); setScenario(result.scenario); setAccount(result.account);
    }).catch(error => setNotice(errorText(error)));
    let received = false;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'boss-local-helper-v1' || event.data.direction !== 'to-extension') return;
      received = true;
      const data = event.data.data;
      setBridgeStatus('● 已收到真实扩展页面观察事件');
      setNotice(previous => previous === bridgeHint ? '' : previous);
      setBridge(previous => [{type: data.type, rows: data.rows?.length, messages: data.messages?.length, sync: data.sync, error: data.error}, ...previous].slice(0, 16));
    };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => {if (!received) {setBridgeStatus(bridgeHint); setNotice(previous => previous || bridgeHint);}}, 3000);
    return () => {active = false; clearTimeout(timer); window.removeEventListener('message', onMessage); delete document.body.__vue__;};
  }, []);
  useEffect(() => {
    if (!diagnostics) return;
    let active = true;
    const refresh = () => {void api<RequestEntry[]>('/__mock/requests').then(result => {if (active) setRequests(result);}).catch(error => {if (active) setNotice(errorText(error));});};
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => {active = false; clearInterval(timer);};
  }, [diagnostics]);
  async function reset(nextScenario = scenario, nextAccount = account) {
    try {await api('/__mock/state', {scenario: nextScenario, account: nextAccount}); location.assign(location.pathname === '/web/geek/jobs' ? '/web/geek/jobs' : '/web/geek/chat');}
    catch (error) {setNotice(errorText(error));}
  }
  return <>
    <header className="topbar"><a className="brand" href="/web/geek/chat">BOSS<span>MOCK / 沟通实验室</span></a><a href="/web/geek/jobs">职位列表</a><a href="/web/geek/recommend?tab=4&sub=1&tag=4">收藏职位</a><span className="local-badge">● 本地模拟环境</span></header>
    <section className="lab" aria-label="开发场景控制"><label>测试场景<select id="scenario" data-testid="scenario" aria-label="测试场景" value={scenario} onChange={event => {setScenario(event.target.value); void reset(event.target.value, account);}}>{Object.entries(config?.scenarios || {}).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>模拟账号<select id="account" data-testid="account" aria-label="模拟账号" value={account} onChange={event => {setAccount(event.target.value); void reset(scenario, event.target.value);}}>{Object.entries(config?.accounts || {}).map(([value, user]) => <option key={value} value={value}>{user.label}</option>)}</select></label><button id="reset" type="button" disabled={!config} onClick={() => void reset()}>重置当前场景</button><details className="help"><summary>如何联调</summary><p>运行 npm run dev，在扩展管理页加载项目根目录下的 extension，然后刷新页面。右下角浮窗提供职位状态、备注和删除；采集页面提供更新与导出。</p><p>切换场景会重置网页数据并刷新页面；不同场景使用独立的会话与 JD ID，插件会新增一套记录，旧场景记录继续保留。全部姓名、公司与消息均为虚构。</p></details></section>
    <p id="notice" className="notice" role="status" hidden={!notice}>{notice}</p>
    {config && (location.pathname === '/web/geek/chat' || location.pathname === '/' ? <Chat config={config} notice={setNotice} /> : <Jobs notice={setNotice} />)}
    <p id="bridge-status" className="bridge-status">{bridgeStatus}</p>
    <details id="diagnostics" className="diagnostics" onToggle={event => setDiagnostics(event.currentTarget.open)}><summary>请求与插件事件 <span id="request-count">{requests.length}</span></summary><p className="muted">仅显示本地模拟请求。同一份扩展在本地 mock 页面跳过采集间隔、周期休息和异常冷却。</p><div className="log-columns"><section><h3>接口请求</h3><pre id="request-log">{requests.slice(-30).reverse().map(item => new Date(item.at).toLocaleTimeString('zh-CN') + '  ' + item.status + '  ' + item.path.split('/').pop() + '  ' + item.bossId + (item.page ? '  page=' + item.page : '')).join('\n') || '暂无请求'}</pre></section><section><h3>插件事件</h3><pre id="bridge-log">{bridge.length ? JSON.stringify(bridge, null, 2) : '等待页面观察事件…'}</pre></section></div></details>
  </>;
}
createRoot(document.getElementById('root')!).render(<App />);
