'use strict';

(() => {
  const $=id=>document.getElementById(id);
  const text=(value,fallback='')=>value==null||value===''?fallback:String(value);
  const list=value=>Array.isArray(value)?value.filter(item=>item&&typeof item==='object'):[];
  const state={account:null};
  let db=null,busy=false,syncRequested=false,stopping=false;

  function node(tag,content){const element=document.createElement(tag);element.textContent=String(content);return element;}
  function describe(value){return value==null||value===''?'未提供':typeof value==='object'?JSON.stringify(value,null,2):String(value);}
  function formatTime(value){if(value==null||value==='')return '未记录';const date=new Date(value);return Number.isNaN(date.getTime())?text(value):date.toLocaleString('zh-CN',{hour12:false});}
  function notify(message,error=false){$('feedback').textContent=message;$('feedback').classList.toggle('error',error);$('feedback').setAttribute('role',error?'alert':'status');}

  async function request(message,account=state.account){
    if(!globalThis.chrome?.runtime?.sendMessage)throw new Error('请从已加载的 Chrome 扩展中打开此页面。');
    if(['DB_GET','EXPORT','SYNC','STOP_SYNC'].includes(message.type)&&(message.type!=='DB_GET'||account!==null))message={...message,account};
    const response=await chrome.runtime.sendMessage(message);
    if(!response?.ok){const reason=response?.error?.message||response?.error||response?.message;throw new Error(typeof reason==='string'?reason:'扩展未返回成功结果，请稍后重试。');}
    if(account&&['DB_GET','EXPORT'].includes(message.type)&&response.data&&response.data.account!==account)throw new Error('返回数据的账号与所选账号不一致，请重新选择账号后重试。');
    return response;
  }
  function setBusy(value){
    busy=value;document.querySelectorAll('button').forEach(element=>{element.disabled=value||stopping||(!db&&element.id!=='refresh');});
    $('account-select').disabled=value||stopping||syncRequested||!db?.accounts.length;
    $('stop-sync').disabled=stopping||!(syncRequested||(!value&&db?.sync?.running));
    $('sync').disabled=value||stopping||!db||Boolean(db.sync.running);
    $('sync-panel').setAttribute('aria-busy',String(value));
  }
  async function action(button,pending,work){
    if(busy||stopping)return;const original=button.textContent;setBusy(true);button.textContent=pending;notify(pending);
    try{await work();}catch(error){notify(text(error?.message,'操作失败，请重试。'),true);}finally{button.textContent=original;setBusy(false);}
  }
  function renderCoverage(){
    const sync=db.sync,entries=Object.entries(sync),names={status:'同步状态',lastSyncAt:'最近同步时间',lastSyncedAt:'最近同步时间',startedAt:'开始时间',finishedAt:'结束时间',updatedAt:'更新时间',coverage:'覆盖范围',limitations:'已知限制',error:'同步错误',message:'同步说明',scope:'采集范围',lastError:'最近错误',running:'正在同步',processed:'已处理数',total:'本次目标数',failed:'失败数',complete:'本次任务完成标记'};
    $('account').textContent='当前账号：'+text(db.account,'未提供账号标识');
    $('sync-state').textContent=sync.running?'同步进行中':sync.complete?'本次任务结束 · 覆盖有限':entries.length?'当前未在同步 · 覆盖待核实':'暂无同步覆盖信息';
    $('sync-progress').textContent='本次已处理 '+text(sync.processed,'—')+' / '+text(sync.total,'—')+' · 失败 '+text(sync.failed,'—')+' · 更新于 '+formatTime(sync.updatedAt);
    $('sync-message').textContent='覆盖说明：'+describe(sync.coverage)+(sync.message?'；'+describe(sync.message):'');
    $('sync-metadata').replaceChildren();
    if(!entries.length)$('sync-metadata').append(node('dt','覆盖情况'),node('dd','尚无同步元数据，无法确认采集范围与历史完整性。'));
    for(const [key,value] of entries){const content=/At$/.test(key)&&(typeof value==='string'||typeof value==='number')?formatTime(value):describe(value);$('sync-metadata').append(node('dt',names[key]||key),node('dd',content));}
  }
  async function load(account=state.account){
    const response=await request({type:'DB_GET'},account);
    if(!response.data||typeof response.data!=='object'||Array.isArray(response.data))throw new Error('本地数据格式异常，请刷新重试。');
    const data=response.data,nextAccount=data.account??null,accounts=new Set(Array.isArray(data.accounts)?data.accounts.filter(value=>typeof value==='string'&&value):[]);
    if(nextAccount)accounts.add(nextAccount);
    db={account:nextAccount,accounts:[...accounts],conversations:list(data.conversations),sync:data.sync&&typeof data.sync==='object'?data.sync:{}};
    state.account=nextAccount;
    $('account-select').replaceChildren();if(!nextAccount)$('account-select').append(new Option('请选择账号',''));
    for(const value of db.accounts)$('account-select').append(new Option(value,value));
    $('account-select').value=nextAccount||'';$('conversation-count').textContent=db.conversations.length;renderCoverage();
  }

  $('account-select').addEventListener('change',async()=>{
    const account=$('account-select').value;
    if(busy||stopping||syncRequested||!account||account===state.account){$('account-select').value=state.account||'';return;}
    setBusy(true);notify('正在切换账号并读取记录…');
    try{await request({type:'SELECT_ACCOUNT',account});await load(account);notify('已切换账号，当前操作与导出均使用所选账号。');}
    catch(error){$('account-select').value=state.account||'';notify('账号切换或读取失败：'+text(error?.message)+'。当前仍显示原账号记录。',true);}finally{setBusy(false);}
  });
  $('refresh').addEventListener('click',()=>action($('refresh'),'正在读取…',async()=>{await load();notify('已刷新本地数据。');}));
  $('sync').addEventListener('click',()=>action($('sync'),'正在请求更新…',async()=>{
    syncRequested=true;setBusy(true);
    try{await request({type:'SYNC'});await load();notify('更新请求已受理，请查看同步进度。');}finally{syncRequested=false;}
  }));
  $('stop-sync').addEventListener('click',async()=>{
    if(stopping||!(syncRequested||(!busy&&db?.sync?.running)))return;
    stopping=true;$('stop-sync').textContent='正在停止…';setBusy(busy);notify('正在请求停止同步…');
    try{await request({type:'STOP_SYNC'});await load();notify('已发送停止请求，已保存的记录仍可查看。');}
    catch(error){notify('停止或刷新失败：'+text(error?.message)+'。请刷新确认同步状态。',true);}finally{stopping=false;$('stop-sync').textContent='停止同步';setBusy(busy);}
  });
  $('export').addEventListener('click',()=>action($('export'),'正在导出…',async()=>{
    const response=await request({type:'EXPORT'});if(!response.data||typeof response.data!=='object')throw new Error('导出失败：未收到有效数据。');
    const blob=new Blob([JSON.stringify(response.data,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');
    anchor.href=url;anchor.download='求职记录-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';document.body.append(anchor);
    try{anchor.click();}finally{anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
    notify('已发起 JSON 文件下载，请在浏览器下载列表中确认。');
  }));
  setInterval(()=>{
    if(busy||stopping||syncRequested||!db?.sync?.running||document.hidden)return;
    setBusy(true);load().catch(error=>notify('读取同步进度失败：'+text(error?.message),true)).finally(()=>setBusy(false));
  },3000);
  setBusy(true);
  const initialAccount=new URLSearchParams(location.search).get('account');
  load(initialAccount||undefined).then(()=>notify('已载入本地记录。')).catch(error=>notify(text(error?.message,'读取失败，请重试。'),true)).finally(()=>setBusy(false));
})();
