import type {ExternalRecord} from './types.ts';
type Progress = (running: boolean, message: string) => Promise<void>;

(() => {
  if (window.__bossLocalHelper) return;
  window.__bossLocalHelper = true;
  const CHANNEL='boss-local-helper-v1';
  const MOCK_ORIGIN='http://127.0.0.1:4173';
  const isMock=location.origin===MOCK_ORIGIN||location.origin===MOCK_ORIGIN.replace('//127.0.0.1:','//localhost:');
  const nativeFetch=window.fetch.bind(window);
  let syncing=false, stopped=false, lastSnapshot='', observing=false, activeController: AbortController | null=null, activeRunId: string | null=null, runController: AbortController | null=null;
  let lastRequest: number | null=null, requestCount=0, cooldownUntil=0, blockedUntil=0;
  function blockFor(ms: number) { if(!isMock)blockedUntil=Math.max(blockedUntil,performance.now()+ms); }
  function serverRetryDelay(response: Response) {
    const raw=response.headers?.get?.('retry-after')?.trim();
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) { const n=Number(raw); return Number.isFinite(n)&&n<=Number.MAX_SAFE_INTEGER/1000?n*1000:0; }
    const date=Date.parse(raw);return Number.isFinite(date)?Math.max(0,date-Date.now()):0;
  }
  const pendingWrites=new Map<string, {account: string; runId?: string; timer: ReturnType<typeof setTimeout>; resolve: () => void; reject: (error: Error) => void}>();
  const pendingUnfavorites=new Map<string, {row: {jobId: string; title: string; companyName: string; favorite: boolean}; account: Promise<string | undefined>; time: number}>();
  function persist(data: ExternalRecord) {
    const requestId=crypto.randomUUID();
    return new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{pendingWrites.delete(requestId);reject(new Error('本地保存确认超时'));},15000);
      pendingWrites.set(requestId,{account:data.account,runId:data.runId,timer,resolve,reject});
      post({...data,requestId});
    });
  }
  function wait(ms: number,signal: AbortSignal) {
    return new Promise<void>((resolve,reject)=>{
      if(signal.aborted)return reject(new Error('用户已停止'));
      const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);resolve();};
      const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(new Error('用户已停止'));};
      const timer=setTimeout(done,ms);signal.addEventListener('abort',cancel,{once:true});
    });
  }
  const text=(v: unknown,n=1200)=>typeof v==='string'?v.slice(0,n):'';
  const allVue=()=>[...document.querySelectorAll('*')].map(e=>e.__vue__).filter((value): value is ExternalRecord => Boolean(value));
  const post=(data: ExternalRecord)=>window.postMessage({channel:CHANNEL,direction:'to-extension',data},location.origin);
  async function account() {
    const user=allVue().find(v=>v.$store?.state?.userInfo?.userId)?.$store.state.userInfo;
    const uid=user?.userId || window._PAGE?.uid;
    if (!uid) return null;
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode((isMock?'boss:mock:':'boss:')+String(uid)));
    return {id:[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,24),uid:String(uid)};
  }
  function rows() {
    const vue=allVue();
    const list=vue.find(v=>v.$options.name==='boss-list' && Array.isArray(v.fullList));
    const source: ExternalRecord[]=list?.fullList || vue.find(v=>v.$options.name==='virtual-list'&&Array.isArray(v.$props?.dataSources))?.$props.dataSources || [];
    const loading=!!list?.isLoading;
    const listEnded=list?.bottomText==='没有更多了';
    return {rows:source.filter(x=>x.encryptBossId),listEnded,loading,loadedEmpty:!!list&&!loading&&listEnded&&source.length===0};
  }
  function cleanRow(r: ExternalRecord) {
    return {id:String(r.encryptBossId),name:text(r.name,100),companyName:text(r.brandName||r.companyName,180),jobId:text(r.encryptJobId,150),jobTitle:text(r.jobName||r.positionName,200),unread:typeof r.unreadCount==='number'&&Number.isFinite(r.unreadCount)&&r.unreadCount>=0?r.unreadCount>0:null,lastText:text(r.lastText),lastIsSelf:typeof r.lastIsSelf==='boolean'?r.lastIsSelf:null,lastMsgStatus:Number.isFinite(Number(r.lastMsgStatus))?Number(r.lastMsgStatus):null,lastMessageAt:Number(r.lastTS)||0,updatedAt:Number(r.updateTime||r.lastTS)||Date.now()};
  }
  function cleanMessage(m: ExternalRecord, uid: string) {
    const body=m.body||{};
    // Keep only useful message fields, never security IDs, avatars, cookies or raw request data.
    const parts=[body.text,body.headTitle,body.jobDesc,body.dialog?.title,body.dialog?.content,body.dialog?.text].filter(x=>typeof x==='string'&&x.trim());
    const isSystem=(m.type===1&&body.type===4)||([3,4].includes(m.type)&&body.type===1&&body.templateId===3)?true:null;
    return {id:String(m.mid||m.cmid||''),time:Number(m.time)||0,type:m.type,bodyType:body.type,templateId:body.templateId,isSystem,direction:String(m.from?.uid)===uid?'out':String(m.to?.uid)===uid?'in':'unknown',directionBasis:String(m.from?.uid)===uid||String(m.to?.uid)===uid?'uid':'unknown',status:Number.isFinite(Number(m.status))?Number(m.status):null,text:[...new Set(parts)].join('\n').slice(0,6000),articles:Array.isArray(body.articles)?body.articles.slice(0,20).map((a: ExternalRecord)=>({title:text(a.title,300),description:text(a.description),url:safeURL(a.url)})):[]};
  }
  function safeURL(value: string) {try {const u=new URL(value); return u.protocol==='https:'&&!/securityId|token|auth|sign=/i.test(u.search)?u.href:'';}catch{return '';}}
  function cleanDetail(d: ExternalRecord) {
    const b=d?.data||{},j=d?.job||{};
    return {companyName:text(j.brandName||b.companyName,180),jobId:text(b.encryptJobId,150),title:text(j.jobName,200),salary:text(j.salaryDesc,100),location:text(j.locationName,100),experience:text(j.experienceName,100),degree:text(j.degreeName,100),bothTalked:!!b.bothTalked};
  }
  function apiURL(path: string,params: ExternalRecord) {const u=new URL(path,location.origin);for(const [k,v] of Object.entries(params))u.searchParams.set(k,String(v??''));return u.href;}
  async function get(path: string,params: ExternalRecord,expectedAccount: string,progress: Progress) {
    const signal=runController!.signal;
    // performance.now is monotonic; request and persistence time count toward the interval.
    let now=performance.now();
    const deadline=isMock?0:Math.max(lastRequest===null?0:lastRequest+3000,cooldownUntil);
    if(now<deadline){
      await progress(true,now<cooldownUntil?'已完成 20 次主动请求，休息 20 秒；可随时停止':'主动请求间隔至少 3 秒，正在等待；可随时停止');
      while((now=performance.now())<deadline)await wait(deadline-now,signal);
    }
    if(signal.aborted)throw new Error('用户已停止');
    if(expectedAccount&&(await account())?.id!==expectedAccount)throw new Error('账号已切换，拒绝读取');
    if(signal.aborted)throw new Error('用户已停止');
    const controller=new AbortController();activeController=controller;
    const cancel=()=>controller.abort();signal.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>controller.abort(),15000);
    lastRequest=performance.now();
    try {
      const response=await nativeFetch(apiURL(path,params),{credentials:'same-origin',redirect:'manual',signal:controller.signal});
      if(response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400){blockFor(300000);throw new Error('接口发生重定向，可能需要登录或安全验证');}
      if(!response.ok){if([401,403,429].includes(response.status))blockFor(Math.max(300000,serverRetryDelay(response)));throw new Error('接口 HTTP '+response.status+'，采集已停止');}
      let body;try{body=await response.json();}catch{blockFor(300000);throw new Error('接口返回非 JSON，可能需要登录或安全验证');}
      if(expectedAccount&&(await account())?.id!==expectedAccount)throw new Error('账号已切换，丢弃本次响应');
      if(!body||typeof body!=='object'||Array.isArray(body)||!Object.hasOwn(body,'code'))throw new Error('接口响应结构异常');
      if(body.code!==0){blockFor(300000);throw new Error('接口 code='+body.code+'，请检查登录或验证页面');}
      if(!body.zpData||typeof body.zpData!=='object'||Array.isArray(body.zpData))throw new Error('接口数据结构异常');
      return body.zpData;
    } catch(error: any) {
      if(signal.aborted)throw new Error('用户已停止');
      blockFor(60000);
      if(controller.signal.aborted)throw new Error('接口请求超时，采集已停止');
      throw error;
    } finally {
      requestCount++;if(!isMock&&requestCount%20===0)cooldownUntil=performance.now()+20000;
      clearTimeout(timer);signal.removeEventListener('abort',cancel);if(activeController===controller)activeController=null;
    }
  }
  function jobPageContext() {
    const visible=(node: Element | null)=>node&&(!node.getClientRects||node.getClientRects().length>0);
    const select=(root: ParentNode,selector: string)=>[...root.querySelectorAll(selector)].find(visible);
    const value=(root: ParentNode,selector: string,limit: number)=>text([...root.querySelectorAll(selector)].find(node=>visible(node)&&node.textContent?.trim())?.textContent?.trim(),limit);
    if(/^\/job_detail\//.test(location.pathname)){
      const label=select(document,'.job-banner .op-btn-like, .job-banner .btn-interest')?.textContent?.trim();
      const favorite=/^(取消收藏|取消感兴趣|已收藏)$/.test(label||'')?true:/^(收藏|感兴趣)$/.test(label||'')?false:undefined;
      return {jobId:location.pathname.split('/').pop()!.replace(/\.html$/,''),companyName:value(document,'.sider-company .company-info a, .job-company .company-name',180),title:value(document,'.job-banner h1',200),...(typeof favorite==='boolean'?{favorite}:{})};
    }
    if(!/^\/web\/geek\/jobs\/?$/.test(location.pathname))return null;
    const detail=select(document,'.job-detail-box')||select(document,'.job-detail-container, .job-detail');
    if(!detail)return {jobId:'',companyName:'',title:''};
    const vue=detail.__vue__;
    const data=vue?.$props?.data||vue?.data||vue?.jobDetail||vue?.$props?.jobDetail||{};
    const info=data.jobInfo||vue?.jobInfo||vue?.$props?.jobInfo||data;
    const card=select(document,'.job-card-box.active, .job-card-wrapper.active, .job-card-wrap.active, .job-card-box.selected, .job-card-wrapper.selected');
    const selected=card?.__vue__?.$props?.data||card?.__vue__?.data||{};
    const cardTitle=card&&value(card,'.job-name',200)||text(selected.jobName,200);
    const cardCompany=card&&value(card,'.company-name, .boss-name',180)||text(selected.brandName,180);
    const link=card&&select(card,'a[href*="/job_detail/"]');
    let jobId=text(selected.encryptJobId,150);
    if(!jobId&&link){try{const url=new URL(link.getAttribute('href') || '',location.origin);if(url.origin===location.origin)jobId=url.pathname.match(/^\/job_detail\/([^/]+)\.html$/)?.[1]||'';}catch{}}
    const detailId=text(info.encryptJobId||info.encryptId,150);
    const matches=!jobId||!detailId||jobId===detailId;
    const title=cardTitle||(matches?value(detail,'.job-name, .job-title, h1',200)||text(info.jobName,200):'');
    const companyName=cardCompany||(matches?text(data.brandComInfo?.brandName,180)||value(detail,'.job-company .company-name, .job-detail-company .company-name, .company-name, .company-info a',180)||text(info.brandName,180):'');
    if(!jobId)jobId=detailId;
    const favorite=matches&&detailId===jobId&&!vue?.$props?.loading?data.relationInfo?.interestJob:undefined;
    return {jobId,companyName,title,...(typeof favorite==='boolean'?{favorite,salary:text(info.salaryDesc,100),location:text(info.locationName,100),experience:text(info.experienceName,100),degree:text(info.degreeName,100)}:{})};
  }
  function favoriteRow(node: Element){
      const company=node.querySelector('.company-info [ka^="personal_interest_brand_"]');
      const link=node.querySelector('.job-info a.name');
      if(!company||!link)return null;
      let jobId;try{const url=new URL(link.getAttribute('href') || '',location.origin);if(url.origin!==location.origin)return null;jobId=url.pathname.match(/^\/job_detail\/([a-zA-Z0-9_-]{1,150})\.html$/)?.[1];}catch{return null;}
      const title=text(node.querySelector('.job-name-text')?.textContent?.trim(),200),companyName=text(company.textContent?.trim(),180);
      return jobId&&title&&companyName?{jobId,title,companyName,favorite:true}:null;
  }
  function favoriteRows(){
    if(location.pathname!=='/web/geek/recommend'||!document.querySelector('[ka="personal_top_interest"].current')||!document.querySelector('[ka="personal_sub_position_focus"].current'))return null;
    return [...document.querySelectorAll('.user-jobs-ul .item-boss')].map(favoriteRow).filter((value): value is NonNullable<typeof value> => Boolean(value));
  }
  async function snapshot() {
    const a=await account();if(!a)return;
    const favorites=favoriteRows();
    if(favorites){
      for(const [id,pending] of pendingUnfavorites){
        if(await pending.account!==a.id||Date.now()-pending.time>15000){pendingUnfavorites.delete(id);continue;}
        if(!favorites.some(row=>row.jobId===id)){favorites.push({...pending.row,favorite:false});pendingUnfavorites.delete(id);}
      }
      const data={type:'FAVORITES',account:a.id,rows:favorites};
      if((await account())?.id!==a.id)return;
      const signature=JSON.stringify(data);if(signature!==lastSnapshot){lastSnapshot=signature;post(data);}return;
    }
    const page=jobPageContext();
    if(page){
      const data={type:'PAGE_CONTEXT',account:a.id,...page};
      if((await account())?.id!==a.id)return;
      const signature=JSON.stringify(data);if(signature!==lastSnapshot){lastSnapshot=signature;post(data);}return;
    }
    if (!/\/web\/geek\/chat/.test(location.pathname)) return;
    const list=rows();
    const record=document.querySelector('.chat-record')?.__vue__;
    const selected=list.rows.find(r=>String(r.encryptBossId)===String(record?.boss?.encryptBossId));
    const live=[...document.querySelectorAll('.message-item')].map(e=>{const m=e.__vue__?.$props?.message;if(!m)return null;const parts=[m.text,m.lastText,m.dialog?.title,m.dialog?.content,m.dialog?.text,...(Array.isArray(m.articles)?m.articles.map((a: ExternalRecord)=>a.title):[])].filter(x=>typeof x==='string'&&x.trim());return{id:String(m.mid||''),time:Number(m.time)||0,type:m.type,bodyType:m.bodyType,templateId:m.templateId,messageType:m.messageType,isSystem:e.classList.contains('item-system'),direction:typeof m.isSelf==='boolean'?(m.isSelf?'out':'in'):'unknown',directionBasis:typeof m.isSelf==='boolean'?'page':'unknown',status:Number.isFinite(Number(m.status))?Number(m.status):null,text:[...new Set(parts)].join('\n').slice(0,6000)};}).filter(Boolean);
    const data={type:'SNAPSHOT',account:a.id,rows:list.rows.map(cleanRow),listEnded:list.listEnded,loading:list.loading,selectedId:selected?String(selected.encryptBossId):null,liveMessages:live};
    if((await account())?.id!==a.id)return;
    const signature=JSON.stringify(data);
    if(signature!==lastSnapshot){lastSnapshot=signature;post(data);
      if(selected&&live.length)post({type:'CONVERSATION',account:a.id,row:cleanRow(selected),messages:live});
    }
  }
  async function collect(commandId: string,expectedAccount: string,runId: string) {
    if(syncing){post({type:'COMMAND_RESULT',commandId,ok:false,error:'已有更新正在进行'});return;}
    if(!runId){post({type:'COMMAND_RESULT',commandId,ok:false,error:'缺少同步任务标识'});return;}
    syncing=true;stopped=false;activeRunId=runId;runController=new AbortController();
    let progress: Progress | undefined,started=false,processed=0,failed=0,incomplete=0;
    try {
      const a=await account();
      if(!a||expectedAccount&&a.id!==expectedAccount)throw new Error('页面账号不匹配，请选择正确账号并打开 BOSS 聊天页');
      const list=rows();
      if(list.loading||!list.rows.length&&!list.loadedEmpty)throw new Error('会话列表尚未加载或无法识别，请打开聊天页稍后重试');
      if(performance.now()<blockedUntil)throw new Error('上次采集遇到异常，请先检查页面，至少等待 '+Math.ceil((blockedUntil-performance.now())/1000)+' 秒后重试');
      // A newly opened tab waits before its first request as well, including after switching tabs.
      if(lastRequest===null)lastRequest=performance.now();
      progress=(running,message)=>persist({type:'SYNC_PROGRESS',account:a.id,runId,sync:{running,processed,total:list.rows.length,failed,complete:!running&&!stopped&&!failed&&!incomplete&&list.listEnded,coverage:'网页已加载列表；无法证明账号全量',message,updatedAt:Date.now()}});
      await progress(true,isMock?'正在读取本地模拟会话，可随时停止':'正在读取已加载会话：主动请求至少间隔 3 秒，每 20 次休息 20 秒，可随时停止');
      started=true;post({type:'COMMAND_RESULT',commandId,ok:true});
      for(const row of list.rows) {
        if(stopped)break;
        if((await account())?.id!==a.id)throw new Error('账号已切换，更新已停止');
        const base={bossId:row.encryptBossId,securityId:row.securityId};
        const messages=[],seen=new Set(),cursors=new Set();let hasMore=true,cursor=0,pages=0,detail={};
        try {
          const rawDetail=await get('/wapi/zpchat/geek/getBossData',{...base,bossSource:0},a.id,progress);
          if(!rawDetail.data||typeof rawDetail.data!=='object'||!rawDetail.job||typeof rawDetail.job!=='object')throw new Error('会话详情响应结构异常');
          detail=cleanDetail(rawDetail);
          while(hasMore&&!stopped&&pages<100) {
            const current=await get('/wapi/zpchat/geek/historyMsg',{...base,maxMsgId:cursor,c:20,page:pages+1,src:0},a.id,progress);
            if(stopped)break;
            if(!Array.isArray(current?.messages)||typeof current.hasMore!=='boolean')throw new Error('历史响应结构变化');
            for(const message of current.messages){const m=cleanMessage(message,a.uid);if(m.id&&!seen.has(m.id)){seen.add(m.id);messages.push(m);}}
            pages++;hasMore=current.hasMore;
            // Advance only after the background transaction has committed this page.
            await persist({type:'CONVERSATION',account:a.id,runId,row:cleanRow(row),detail,messages:current.messages.map((m: ExternalRecord)=>cleanMessage(m,a.uid)),history:{runId,pages,serverReportsEnd:!hasMore,continuousFromStart:true,count:messages.length,updatedAt:Date.now()}});
            if(hasMore){const next=current.minMsgId;if(!next||cursors.has(String(next)))throw new Error('历史游标停滞，已保留当前页');cursors.add(String(next));cursor=next;}
          }
          if(hasMore)incomplete++;
        }catch(error: any){if(!stopped)post({type:'SYNC_ERROR',account:a.id,runId,conversationId:String(row.encryptBossId),error:String(error.message).slice(0,250)});throw error;}
        processed++;await progress(true,isMock?`已处理 ${processed}/${list.rows.length} 个本地模拟会话`:`已处理 ${processed}/${list.rows.length} 个会话；主动请求至少间隔 3 秒，每 20 次休息 20 秒`);
      }
      await progress(false,stopped?'已停止；已保存内容仍在本地':`更新结束：${processed} 个会话，${failed} 个失败，${incomplete} 个历史未读完。范围为网页当前列表。`);
    }catch(error: any){
      if(!stopped){failed++;if(started)blockFor(60000);}
      const retryNote=!stopped&&performance.now()<blockedUntil?'；请检查页面，至少等待 '+Math.ceil((blockedUntil-performance.now())/1000)+' 秒后再试':'';
      if(started&&progress)await progress(false,stopped?'已停止；已保存内容仍在本地':('采集已中止：'+String(error.message)+retryNote).slice(0,250)).catch(()=>{});
      else post({type:'COMMAND_RESULT',commandId,ok:false,error:String(error.message).slice(0,250)});
    }finally{syncing=false;activeRunId=null;runController=null;}
  }
  // Observe only existing site's responses; this never invokes send/resume/read-ack APIs.
  async function requestContext(url: string) {
    if(!/\/web\/geek\/chat/.test(location.pathname))return null;
    const a=await account();if(!a)return null;
    let u;try{u=new URL(url,location.origin);}catch{return null;}
    const row=rows().rows.find(r=>String(r.encryptBossId)===u.searchParams.get('bossId'));
    return row?{a,row:cleanRow(row)}:null;
  }
  async function observe(url: string,body: ExternalRecord,contextPromise: ReturnType<typeof requestContext>) {
    if(!body||body.code!==0)return;
    let u;try{u=new URL(url,location.origin);}catch{return;}
    if(u.origin!==location.origin)return;
    const context=await contextPromise;if(!context)return;
    const {a,row}=context;
    if((await account())?.id!==a.id)return;
    if(u.pathname==='/wapi/zpchat/geek/historyMsg')post({type:'CONVERSATION',account:a.id,row,messages:(body.zpData?.messages||[]).slice(0,200).map((m: ExternalRecord)=>cleanMessage(m,a.uid)),history:{observedEnd:body.zpData?.hasMore===false,updatedAt:Date.now()}});
    if(u.pathname==='/wapi/zpchat/geek/getBossData')post({type:'CONVERSATION',account:a.id,row,detail:cleanDetail(body.zpData)});
  }
  const observedPath=(url: string)=>{try{const u=new URL(url,location.origin);return u.origin===location.origin&&['/wapi/zpchat/geek/historyMsg','/wapi/zpchat/geek/getBossData'].includes(u.pathname);}catch{return false;}};
  window.fetch=async function(input,init){const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;const context=observedPath(url)?requestContext(url):null;const response=await nativeFetch(input,init);if(context)response.clone().json().then(b=>observe(url,b,context)).catch(()=>{});return response;};
  const nativeOpen=XMLHttpRequest.prototype.open,nativeSend=XMLHttpRequest.prototype.send;
  const xhrURLs=new WeakMap<XMLHttpRequest, string>();
  XMLHttpRequest.prototype.open=function(method: string,url: string | URL,async: boolean=true,username?: string | null,password?: string | null){xhrURLs.set(this,String(url));return nativeOpen.call(this,method,url,async,username,password);};
  XMLHttpRequest.prototype.send=function(...args){const url=xhrURLs.get(this) || '';if(observedPath(url)){const context=requestContext(url);this.addEventListener('load',()=>{try{observe(url,this.responseType==='json'?this.response:JSON.parse(this.responseText),context).catch(()=>{});}catch{}},{once:true});}return nativeSend.apply(this,args);};
  // Message transport from isolated content script, with only two allowed read commands.
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin||event.data?.channel!==CHANNEL||event.data.direction!=='to-page')return;
    const data=event.data.data||{};
    if(data.type==='INGEST_ACK'){
      const p=pendingWrites.get(data.requestId);
      if(p&&p.account===data.account&&p.runId===data.runId){clearTimeout(p.timer);pendingWrites.delete(data.requestId);if(data.ok)p.resolve();else p.reject(new Error(data.error||'本地保存失败'));}
    }
    if(data.type==='SYNC')collect(data.commandId,data.account,data.runId);
    if(data.type==='STOP_SYNC'){
      const matches=syncing&&activeRunId===data.runId;
      if(matches){stopped=true;runController?.abort();activeController?.abort();}
      post({type:'COMMAND_RESULT',commandId:data.commandId,ok:matches,error:matches?undefined:'该同步任务已不在此页面运行'});
    }
    if(data.type==='SNAPSHOT')snapshot().catch(()=>{});
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  document.addEventListener('click',event=>{
    const action=(event.target as Element | null)?.closest?.('[ka^="personal_interest_cancel_"]'),node=action?.closest('.item-boss');
    if(!node||favoriteRows()===null)return;
    const row=favoriteRow(node);if(row)pendingUnfavorites.set(row.jobId,{row,account:account().then(value=>value?.id),time:Date.now()});
  },true);
  function schedule(){clearTimeout(timer);timer=setTimeout(()=>snapshot().catch(()=>{}),700);}
  function start(){if(observing)return;observing=true;new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true,characterData:true});schedule();setInterval(()=>snapshot().catch(()=>{}),5000);}
  if(document.documentElement)start();else document.addEventListener('DOMContentLoaded',start,{once:true});
})();
