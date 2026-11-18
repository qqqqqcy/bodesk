import {useEffect, useRef, useState} from 'react';
import {api, errorText} from './api.ts';
import type {JobDetail, JobFixtures, MockRow} from './types.ts';

export function Jobs({notice}: {notice: (message: string) => void}) {
  const [fixtures, setFixtures] = useState<JobFixtures | null>(null);
  const [selected, setSelected] = useState<MockRow | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('normal');
  const revision = useRef(0);
  const path = location.pathname;
  const favorites = path === '/web/geek/recommend';
  const standalone = path.startsWith('/job_detail/');
  const run = async (work: () => Promise<void>) => {try {await work();} catch (error) {notice(errorText(error));}};
  async function choose(row: MockRow, source = fixtures!) {
    const selection = ++revision.current;
    setSelected(row); setLoading(true);
    if (mode === 'delayed') await new Promise<void>(resolve => setTimeout(resolve, 1500));
    if (selection !== revision.current) return;
    setDetail(source.details[row.encryptJobId]); setLoading(false);
  }
  async function toggle(row = selected, currentDetail = detail) {
    if (!row || loading) return;
    const favorite = favorites ? false : !currentDetail?.relationInfo.interestJob;
    await api('/__mock/favorite', {jobId: row.encryptJobId, favorite});
    if (favorites) setFixtures(previous => previous && {...previous, rows: previous.rows.filter(item => item.encryptJobId !== row.encryptJobId)});
    else if (currentDetail) {
      currentDetail.relationInfo.interestJob = favorite;
      if (selected?.encryptJobId === row.encryptJobId) setDetail({...currentDetail, relationInfo: {...currentDetail.relationInfo}});
    }
  }
  useEffect(() => {
    let active = true;
    void run(async () => {
      const result = await api<JobFixtures>('/__mock/jobs');
      if (favorites) result.rows = (await api<{rows: MockRow[]}>('/__mock/favorites')).rows;
      if (!active) return;
      setFixtures(result);
      const row = standalone ? result.rows.find(item => item.encryptJobId === path.split('/').pop()?.replace(/\.html$/, '')) : result.rows[0];
      if (row && !favorites) await choose(row, result);
    });
    return () => {active = false; revision.current++;};
  }, []);
  if (favorites) return <main id="favorites-layout" className="job-page"><nav className="user-jobs-tab-nav"><span className="current" {...{ka: 'personal_top_interest'}}>感兴趣 <span id="favorites-count">{fixtures?.rows.length || 0}</span></span><span className="current" {...{ka: 'personal_sub_position_focus'}}>职位收藏</span></nav><ul id="favorites-list" className="user-jobs-ul">{fixtures?.rows.map(row => <li key={row.encryptJobId} className={'item-boss' + (row.closed ? ' job-closed' : '')} data-job-id={row.encryptJobId}><div className="company-info"><a href="#" {...{ka: 'personal_interest_brand_' + row.encryptBrandId}}>{row.brandName}</a></div><div className="job-info"><a className="name" href={'/job_detail/' + row.encryptJobId + '.html'} target="_blank" rel="noopener noreferrer"><span className="job-name-text">{row.jobName}</span></a></div>{row.closed ? <span className="muted">职位已下架</span> : <button className="btn-like" {...{ka: 'personal_interest_cancel_' + row.encryptJobId}} onClick={() => void run(() => toggle(row))}>取消感兴趣</button>}</li>)}</ul><aside className="sider-recommend"><a href="/job_detail/ignored-recommendation.html">侧栏推荐职位（不是收藏）</a></aside></main>;
  if (standalone) return <main id="job-layout" className="job-page"><a href="/web/geek/chat">← 返回沟通</a><section className="job-banner"><p className="eyebrow">模拟职位详情</p><h1>{selected?.jobName || (fixtures ? '当前模拟账号未找到该职位' : '正在读取职位…')}</h1><p id="job-meta">{detail && [detail.jobInfo.salaryDesc, detail.jobInfo.locationName, detail.jobInfo.experienceName, detail.jobInfo.degreeName].join('　/　')}</p><button id="job-detail-favorite" className={'op-btn-like' + (detail?.relationInfo.interestJob ? ' active' : '')} disabled={!detail} onClick={() => void run(() => toggle())}>{detail?.relationInfo.interestJob ? '取消收藏' : '收藏'}</button></section><section className="sider-company"><h2>公司信息</h2><div className="company-info"><a href="/web/geek/chat">{selected?.brandName}</a></div></section><section className="job-description"><h2>职位描述</h2><p>与团队协作，设计清晰、稳定、易维护的产品体验。这是用于插件开发的虚构职位，支持公司与 JD 浮窗上下文验证。</p></section></main>;
  const preview = selected && fixtures && Object.values(fixtures.cases).includes(selected.encryptJobId) && selected.encryptJobId !== fixtures.cases.existing;
  return <main id="jobs-layout" className="jobs-page" ref={element => {if (element) element.__vue__ = {$options: {name: 'PageJobs'}, jobList: fixtures?.rows || [], currentJob: selected, jobDetail: detail || {}, jobDetailLoading: loading};}}>
    <section><h1>模拟职位列表</h1><p className="muted">选择职位，验证浮窗只读识别与已有 JD 高亮。</p><label>详情加载 <select id="job-detail-mode" value={mode} onChange={event => setMode(event.target.value)}><option value="normal">立即显示</option><option value="delayed">延迟 1.5 秒，保留上一条详情</option></select></label><div id="job-results">{fixtures?.rows.map(row => <div key={row.encryptJobId} className={'job-card-wrap' + (row.encryptJobId === selected?.encryptJobId ? ' active' : '')} data-job-id={row.encryptJobId} ref={element => {if (element) element.__vue__ = {$options: {name: 'JodCard'}, $props: {data: row, showBottom: true, showJobType: false, isActive: row.encryptJobId === selected?.encryptJobId}};}} onClick={event => {event.preventDefault(); void run(() => choose(row));}}><div className="job-card-box"><a className="job-name" href={'/job_detail/' + row.encryptJobId + '.html'}>{row.jobName}</a><span className="boss-name">{row.brandName}</span></div></div>)}</div></section>
    <div className="job-detail-container"><p id="job-detail-loading" role="status" hidden={!loading}>{loading ? '正在加载职位详情…' : ''}</p><section className="job-detail-box" hidden={!selected} ref={element => {if (element) element.__vue__ = {$options: {name: 'JodCardDetail'}, $props: {data: detail || {}, loading, isScroll: false, isStudent: false, cityCode: '101010100', hideCanFeedback: false}};}}><h2 className="job-name">{detail?.jobInfo.jobName}</h2><div className="job-company"><span className="brand-name">{detail?.brandComInfo.brandName}</span></div><button id="preview-favorite" className="op-btn-like" disabled={loading || !detail} onClick={() => void run(() => toggle())}>{detail?.relationInfo.interestJob ? '取消收藏' : '收藏'}</button><p className="job-preview-hint">{preview ? '此职位仅存在于浏览列表，不在聊天列表中。' : '此职位也存在于模拟聊天列表，可先采集再验证高亮。'}</p><a className="job-detail-link" href={'/job_detail/' + selected?.encryptJobId + '.html'} hidden={!!preview}>查看职位详情</a><h3>职位描述</h3><p>此处为虚构的当前 JD。浏览和切换不应增加插件中的公司、职位或沟通记录。</p></section></div>
  </main>;
}
