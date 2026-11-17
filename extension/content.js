(() => {
  const CHANNEL='boss-local-helper-v1';
  const pending=new Map(),drafts=new Map();
  let widget,company,jobs,notice,companyNotes,companyEdit,lastAccount=null,currentContext=null,lastData=null,activeEditor=null,editorSession=0,renderVersion=0,refreshTimer,renderedSignature='';
  const labels={unknown:'待确认',resume_event:'简历状态',resume_requested:'对方请求附件简历',awaiting_self:'待自己回复',awaiting_boss:'待 Boss 回复',unread:'未读',read:'自己已读未交互',greeting_unread:'已发送招呼（对方未读）',greeting_read:'已发送招呼（对方已读）',resume_applied:'附件简历请求已发送',resume_sent:'简历已发送',resume_viewed:'简历已查看',communication_rejected:'对方拒绝沟通',interviewing:'面试中',passed:'面试通过',failed:'面试失败'};
  const normalizedStatus=value=>/^interview_[1-9]\d*$/.test(value)?'interviewing':value;
  const statusLabel=value=>labels[normalizedStatus(value)]||'待确认';
  const element=(tag,className,text)=>{const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;};
  function jobURL(value){try{const url=new URL(value);const allowed=url.origin==='https://www.zhipin.com'||['http://127.0.0.1:4173','http://localhost:4173'].includes(url.origin);return allowed&&/^\/job_detail\/[a-zA-Z0-9_-]+\.html$/.test(url.pathname)?url.origin+url.pathname:'';}catch{return '';}}
  function post(data){window.postMessage({channel:CHANNEL,direction:'to-page',data},location.origin);}
  function ensureWidget(){
    if(widget?.isConnected)return;
    widget=element('aside');widget.id='boss-local-helper-widget';widget.setAttribute('aria-label','公司与职位沟通状态');
    const heading=element('div','bh-company-line');
    company=element('strong','bh-company',currentContext?.companyName||'请选择一个对话或职位');
    companyEdit=element('button','bh-link-button','备注');companyEdit.type='button';companyEdit.disabled=true;companyEdit.setAttribute('aria-label','编辑公司备注');
    companyEdit.addEventListener('click',()=>{if(lastData?.companyId)openEditor('company',lastData.companyId,{note:lastData.companyNote||''});});
    heading.append(company,companyEdit);
    companyNotes=element('div','bh-company-notes');jobs=element('div','bh-jobs');
    notice=element('p','bh-notice',currentContext?'正在读取职位状态…':'');notice.setAttribute('role','status');notice.hidden=!currentContext;
    const button=element('button','bh-overview','采集 / 导出');button.type='button';button.addEventListener('click',async()=>{try{const result=await chrome.runtime.sendMessage({type:'OPEN_DASHBOARD',account:currentContext?.account||lastAccount});if(!result?.ok)showNotice(result?.error||'打开采集页面失败');}catch{showNotice('扩展已更新，请刷新页面');}});
    const controls=element('div','bh-controls');controls.append(button);widget.append(heading,companyNotes,jobs,notice,controls);document.body.append(widget);
    if(!refreshTimer)refreshTimer=setInterval(()=>{if(currentContext&&!document.hidden&&!activeEditor)refreshWidget();},5000);
  }
  function showNotice(text){if(notice){notice.textContent=text;notice.hidden=!text;}}
  async function deleteJob(job,account){
    if(activeEditor){showNotice('请先保存或取消正在编辑的内容');return false;}
    if(!window.confirm('确定删除“'+(job.title||'未命名职位')+'”？该职位的备注和状态将被删除，之后不会自动重新收录；已有对话会保留。'))return false;
    const result=await chrome.runtime.sendMessage({type:'DELETE_JOB',account,jobId:job.id,expectedUpdatedAt:job.updatedAt});
    if(!result?.ok)throw new Error(result?.error||'删除职位失败');
    drafts.delete(JSON.stringify([account,'job',job.id]));
    if(currentContext?.account===account){renderedSignature='';await refreshWidget();showNotice('已删除“'+(job.title||'未命名职位')+'”。');}
    else showNotice('职位已删除。');
    return true;
  }
  const editorKey=(kind,id)=>JSON.stringify([currentContext?.account,kind,id]);
  function openEditor(kind,id,initial){
    if(!currentContext||currentContext.preview||!id)return;
    const key=editorKey(kind,id);if(!drafts.has(key))drafts.set(key,{...initial,baseNote:initial.note,baseStatus:initial.status,revision:0});
    activeEditor=key;editorSession++;renderVersion++;renderData(lastData);
  }
  function statusOptions(job){
    const entries=[['auto','跟随自动判断'],['awaiting_self','待自己回复'],['awaiting_boss','待 Boss 回复'],['resume_requested','对方请求附件简历'],['resume_applied','附件简历请求已发送'],['resume_sent','简历已发送'],['resume_viewed','简历已查看']];
    entries.push(['communication_rejected','对方拒绝沟通'],['interviewing','面试中'],['passed','面试通过'],['failed','面试失败'],['unknown','待确认']);
    const currentStatus=normalizedStatus(job.status);
    if(job.manual&&!entries.some(([value])=>value===currentStatus))entries.push([currentStatus,statusLabel(currentStatus)]);
    return entries;
  }
  function makeEditor(kind,id,job){
    const context=currentContext,data=lastData,key=editorKey(kind,id),draft=drafts.get(key),session=editorSession,form=element('form','bh-editor');
    let select;
    if(kind==='job'){
      const label=element('label','bh-field','当前状态');select=element('select','bh-status-select');select.setAttribute('aria-label','修改职位状态');
      for(const [value,text] of statusOptions(job)){const option=element('option','',text);option.value=value;select.append(option);}
      select.value=draft.status;select.addEventListener('change',()=>{draft.status=select.value;draft.revision++;});label.append(select);form.append(label);
    }
    const label=element('label','bh-field',kind==='company'?'公司备注':'JD 备注'),input=element('textarea','bh-note-input');
    input.rows=3;input.maxLength=10000;input.value=draft.note;input.placeholder=kind==='company'?'记录这家公司的沟通情况、偏好等':'记录这个职位的沟通要点、面试安排等';input.setAttribute('aria-label',kind==='company'?'公司备注':'JD 备注');input.addEventListener('input',()=>{draft.note=input.value;draft.revision++;});label.append(input);form.append(label);
    const feedback=element('p','bh-editor-feedback');feedback.hidden=true;feedback.setAttribute('role','status');
    const actions=element('div','bh-editor-actions'),save=element('button','bh-save','保存'),cancel=element('button','bh-cancel','取消');save.type='submit';cancel.type='button';
    cancel.addEventListener('click',()=>{drafts.delete(key);activeEditor=null;renderData(lastData);refreshWidget();});actions.append(save,cancel);form.append(feedback,actions);
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(save.disabled)return;
      draft.note=input.value;if(select)draft.status=select.value;
      const submitted={note:draft.note,status:draft.status,revision:draft.revision},noteChanged=submitted.note!==draft.baseNote,statusChanged=kind==='job'&&submitted.status!==draft.baseStatus;
      for(const e of [save,cancel,input,select].filter(Boolean))e.disabled=true;
      feedback.hidden=false;feedback.textContent='正在保存…';
      let message;
      if(kind==='company'&&noteChanged)message={type:'SAVE_COMPANY_NOTE',account:context.account,companyId:id,companyName:data.companyName,note:submitted.note,expectedNote:draft.baseNote};
      if(kind==='job'&&(noteChanged||statusChanged))message={type:'SAVE_JOB',account:context.account,jobId:id,...(statusChanged?{status:submitted.status,expectedManualStatus:draft.baseStatus==='auto'?null:draft.baseStatus}:{}),...(noteChanged?{note:submitted.note,expectedNote:draft.baseNote}:{}),context:{companyId:data.companyId,companyName:data.companyName,title:job.title}};
      try{
        if(message){const result=await chrome.runtime.sendMessage(message);if(!result?.ok)throw new Error(result?.error||'本地保存失败');}
        const owns=currentContext===context&&activeEditor===key&&editorSession===session;
        if(drafts.get(key)===draft){
          if(noteChanged)draft.baseNote=submitted.note;if(statusChanged)draft.baseStatus=submitted.status;
          if(draft.revision===submitted.revision&&(owns||activeEditor!==key))drafts.delete(key);
        }
        if(owns){activeEditor=null;renderData(lastData);await refreshWidget();showNotice(message?'已保存':'没有更改');}
      }catch(error){
        feedback.textContent=error?.message||'保存失败，请重试';
        for(const e of [save,cancel,input,select].filter(Boolean))e.disabled=false;
      }
    });
    return form;
  }
  function renderData(data){
    if(!data||!currentContext)return;
    renderedSignature=JSON.stringify(data);
    company.textContent=data.companyName||currentContext.companyName||'公司待识别';companyEdit.disabled=currentContext.preview||!data.companyId;
    const ck=editorKey('company',data.companyId);companyNotes.replaceChildren();
    if(activeEditor===ck)companyNotes.append(makeEditor('company',data.companyId));
    else if(data.companyNote)companyNotes.append(element('p','bh-note-text',data.companyNote));
    const rows=Array.isArray(data.jobs)?[...data.jobs]:[];
    // The backend orders by earliest known conversation time; selection only changes highlighting.
    const fragment=document.createDocumentFragment();
    for(const job of rows){
      const row=element('div','bh-job');if(job.current){row.classList.add('bh-current');row.setAttribute('aria-current','true');}
      const url=jobURL(job.url),line=element('div','bh-job-line'),title=element(url?'a':'span','bh-job-title',job.title||'待识别 JD');
      if(url){title.href=url;title.target='_blank';title.rel='noopener noreferrer';}
      const displayed=(!job.manual&&job.status==='resume_event'&&job.label?job.label:statusLabel(job.status))+(job.manual?'（手动）':'');
      const status=element('button','bh-job-status',displayed);status.type='button';status.disabled=currentContext.preview||!job.id;status.setAttribute('aria-label',(currentContext.preview?'查看 ':'修改 ')+(job.title||'当前职位')+' 的状态');
      const open=()=>openEditor('job',job.id,{status:job.manual?normalizedStatus(job.status):'auto',note:job.note||''});status.addEventListener('click',open);line.append(title,status);row.append(line);
      if(job.favorite)row.append(element('span','bh-favorite','已收藏'));
      const key=editorKey('job',job.id);
      if(activeEditor===key)row.append(makeEditor('job',job.id,job));
      else{
        if(job.note)row.append(element('p','bh-note-text',job.note));
        const history=Array.isArray(job.noteConflicts)?job.noteConflicts.filter(n=>typeof n?.text==='string'&&n.text):[];
        if(history.length){const details=element('details','bh-note-history');details.append(element('summary','','合并前的备注（'+history.length+'）'));for(const note of history)details.append(element('p','bh-note-text',note.text));row.append(details);}
        const actions=element('div','bh-job-actions');
        if(!currentContext.preview){const edit=element('button','bh-link-button bh-job-note-edit',job.note?'编辑备注':'添加备注');edit.type='button';edit.disabled=!job.id;edit.addEventListener('click',open);actions.append(edit);}
        const remove=element('button','bh-link-button bh-job-delete','删除');remove.type='button';remove.disabled=!job.id||!job.persisted;remove.setAttribute('aria-label','删除 '+(job.title||'未命名职位'));
        remove.addEventListener('click',async()=>{if(remove.disabled)return;remove.disabled=true;try{await deleteJob(job,currentContext.account);}catch(error){showNotice(error?.message||'删除职位失败');}finally{remove.disabled=false;}});
        actions.append(remove);row.append(actions);
      }
      fragment.append(row);
    }
    jobs.replaceChildren(fragment);showNotice(rows.length?'':'暂无已记录的 JD');
  }
  function chooseContext(data){
    let next=null;
    if(data.type==='PAGE_CONTEXT')next={account:data.account,jobId:data.jobId||'',companyName:data.companyName||'',title:data.title||'',preview:true};
    if(data.type==='SNAPSHOT'){const row=(data.rows||[]).find(r=>r.id===data.selectedId);if(row)next={account:data.account,jobId:row.jobId||'',companyName:row.companyName||'',title:row.jobTitle||''};}
    if(data.type!=='PAGE_CONTEXT'&&data.type!=='SNAPSHOT')return;
    if(JSON.stringify(next)===JSON.stringify(currentContext))return;
    currentContext=next;lastData=null;activeEditor=null;editorSession++;renderedSignature='';renderVersion++;
    if(document.body){ensureWidget();company.textContent=next?.companyName||'请选择一个对话或职位';companyEdit.disabled=true;companyNotes.replaceChildren();jobs.replaceChildren();showNotice(next?'正在读取职位状态…':'');}
  }
  async function refreshWidget(){
    if(!document.body||activeEditor)return;
    ensureWidget();const context=currentContext;if(!context)return;const version=++renderVersion;
    try{
      const response=await chrome.runtime.sendMessage({type:'WIDGET_GET',...context});
      if(version!==renderVersion||context!==currentContext||activeEditor)return;
      if(!response?.ok){showNotice(response?.error||'本地职位状态读取失败');return;}
      lastData=response.data||{};if(JSON.stringify(lastData)!==renderedSignature)renderData(lastData);
    }catch{if(version===renderVersion)showNotice('扩展连接中断，请刷新页面');}
  }
  window.addEventListener('message',async event=>{
    if(event.source!==window||event.origin!==location.origin||event.data?.channel!==CHANNEL||event.data.direction!=='to-extension')return;
    const d=event.data.data;if(!d||typeof d!=='object')return;
    if(d.type==='COMMAND_RESULT'){const p=pending.get(d.commandId);if(p){clearTimeout(p.timer);pending.delete(d.commandId);p.resolve(d);}return;}
    if(!['SNAPSHOT','CONVERSATION','SYNC_PROGRESS','SYNC_ERROR','PAGE_CONTEXT','FAVORITES'].includes(d.type))return;
    if(typeof d.account==='string')lastAccount=d.account;chooseContext(d);
    try{
      const result=await chrome.runtime.sendMessage({type:'INGEST',data:d});
      if(d.requestId)post({type:'INGEST_ACK',requestId:d.requestId,account:d.account,runId:d.runId,ok:result?.ok===true,error:result?.error||(!result?.ok?'本地数据库更新失败':undefined)});
      if(!document.body)return;ensureWidget();
      if(!result?.ok){showNotice(result?.error||'本地数据库更新失败');return;}
      if(currentContext?.account===d.account&&['SNAPSHOT','CONVERSATION','PAGE_CONTEXT','FAVORITES'].includes(d.type))await refreshWidget();
    }catch{
      if(d.requestId)post({type:'INGEST_ACK',requestId:d.requestId,account:d.account,runId:d.runId,ok:false,error:'扩展连接中断，请刷新页面'});
      showNotice('扩展连接中断，请刷新页面');
    }
  });
  chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
    if(message.type==='ACCOUNT_INFO'){sendResponse({account:lastAccount});return;}
    if(!['SYNC','STOP_SYNC'].includes(message.type))return;
    const commandId=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(commandId);sendResponse({ok:false,error:'网页未响应，请确认聊天页已加载并刷新'});},12000);
    pending.set(commandId,{timer,resolve:sendResponse});post({type:message.type,commandId,account:message.account,runId:message.runId});return true;
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&currentContext&&!activeEditor)refreshWidget();});
  if(document.body)ensureWidget();else document.addEventListener('DOMContentLoaded',()=>{ensureWidget();refreshWidget();},{once:true});
  post({type:'SNAPSHOT'});
})();
