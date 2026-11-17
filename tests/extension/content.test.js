import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../../extension/content.js',import.meta.url),'utf8');
function harness(sendMessage){
  let listener;const output=[];
  const window={postMessage:event=>output.push(event.data),addEventListener:(name,fn)=>{listener=fn;}};
  const document={body:null,addEventListener(){}};
  const chrome={runtime:{sendMessage,onMessage:{addListener(){}}}};
  vm.runInNewContext(source,{window,document,chrome,location:{origin:'https://www.zhipin.com'},crypto:webcrypto,setTimeout,clearTimeout});
  return {deliver:data=>listener({source:window,origin:'https://www.zhipin.com',data:{channel:'boss-local-helper-v1',direction:'to-extension',data}}),output};
}
function visualHarness(sendMessage,{confirm=()=>true}={}){
  class Element {
    constructor(tag){this.tagName=tag;this.children=[];this.className='';this.attributes={};this.isConnected=false;this.value='';this.handlers={};}
    set textContent(value){this.text=String(value);this.children=[];}
    get textContent(){return (this.text||'')+this.children.map(e=>e.textContent).join('');}
    append(...items){for(const item of items){if(item.tagName==='fragment')this.children.push(...item.children);else this.children.push(item);item.isConnected=true;}}
    replaceChildren(...items){this.children=[];this.text='';this.append(...items);}
    setAttribute(name,value){this.attributes[name]=value;}
    addEventListener(name,fn){(this.handlers[name]??=[]).push(fn);}
    async emit(name){for(const fn of this.handlers[name]||[])await fn({preventDefault(){}});}
    get classList(){return{add:name=>{this.className+=' '+name;}};}
  }
  let listener,tick;const documentListeners={};
  const body=new Element('body');
  const document={body,hidden:false,createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('fragment'),addEventListener:(name,handler)=>{documentListeners[name]=handler;}};
  const window={postMessage(){},confirm,addEventListener:(name,fn)=>{listener=fn;}};
  const chrome={runtime:{sendMessage,onMessage:{addListener(){}}}};
  vm.runInNewContext(source,{window,document,chrome,location:{origin:'https://www.zhipin.com'},crypto:webcrypto,URL,setTimeout,clearTimeout,setInterval:fn=>{tick=fn;return 1;}});
  return {widget:()=>body.children[0],tick:()=>tick?.(),visibility:hidden=>{document.hidden=hidden;documentListeners.visibilitychange?.();},deliver:data=>listener({source:window,origin:'https://www.zhipin.com',data:{channel:'boss-local-helper-v1',direction:'to-extension',data}})};
}
const find=(root,cls)=>root?.className.split(' ').includes(cls)?root:root?.children.map(c=>find(c,cls)).find(Boolean);
const all=(root,cls)=>[...(root?.className.split(' ').includes(cls)?[root]:[]),...(root?.children||[]).flatMap(c=>all(c,cls))];
const currentStatus=h=>find(all(h.widget(),'bh-job').find(r=>r.attributes['aria-current']==='true'),'bh-job-status');
const rowTitles=h=>all(h.widget(),'bh-job').map(row=>find(row,'bh-job-title').textContent);
const snapshot=(account='a',jobId='j1')=>({type:'SNAPSHOT',account,selectedId:'c1',rows:[{id:'c1',jobId,companyName:'示例公司',jobTitle:jobId==='j1'?'前端':'后端'}]});
// The server returns the older JD first, while the current JD is the second row.
const data=()=>({companyId:'company-a',companyName:'示例公司',companyNote:'公司原备注',settings:{},jobs:[{id:'j2',title:'后端',persisted:true,updatedAt:20,firstConversationAt:10,status:'awaiting_self',note:''},{id:'j1',title:'前端',persisted:true,updatedAt:30,firstConversationAt:20,status:'resume_event',label:'附件简历请求已发送',manual:false,current:true,note:'职位原备注'}]});

test('浮窗可手动选择拒绝沟通，保存后展示手动标识并可恢复自动',async()=>{
  const sent=[],d=data();
  const h=visualHarness(async message=>{
    sent.push(message);
    if(message.type==='INGEST')return{ok:true};
    if(message.type==='SAVE_JOB'){d.jobs[1].manual=message.status!=='auto';d.jobs[1].status=d.jobs[1].manual?message.status:'resume_event';return{ok:true};}
    return{ok:true,data:d};
  });
  await h.deliver(snapshot());await currentStatus(h).emit('click');
  let select=find(h.widget(),'bh-status-select');
  assert.equal(select.children.find(option=>option.value==='communication_rejected').textContent,'对方拒绝沟通');
  select.value='communication_rejected';await select.emit('change');await find(h.widget(),'bh-editor').emit('submit');
  assert.equal(sent.find(message=>message.type==='SAVE_JOB').status,'communication_rejected');
  assert.equal(currentStatus(h).textContent,'对方拒绝沟通（手动）');
  await h.tick();assert.equal(currentStatus(h).textContent,'对方拒绝沟通（手动）');
  await currentStatus(h).emit('click');select=find(h.widget(),'bh-status-select');assert.equal(select.value,'communication_rejected');
  select.value='auto';await select.emit('change');await find(h.widget(),'bh-editor').emit('submit');
  assert.equal(currentStatus(h).textContent,'附件简历请求已发送');
});

test('职位页的JD卡片可直接删除，取消确认不写入，成功后刷新浮窗',async()=>{
  const sent=[],d=data();let approved=false;
  const h=visualHarness(async message=>{sent.push(message);if(message.type==='INGEST')return{ok:true};if(message.type==='DELETE_JOB'){d.jobs=d.jobs.filter(job=>job.id!==message.jobId);return{ok:true};}return{ok:true,data:d};},{confirm:()=>approved});
  await h.deliver({type:'PAGE_CONTEXT',account:'a',jobId:'j1',companyName:'示例公司',title:'前端'});
  let remove=find(all(h.widget(),'bh-job').find(row=>row.attributes['aria-current']==='true'),'bh-job-delete');
  assert.equal(remove.disabled,false);await remove.emit('click');assert.ok(!sent.some(message=>message.type==='DELETE_JOB'));
  approved=true;await remove.emit('click');const deletion=sent.find(message=>message.type==='DELETE_JOB');
  assert.equal(deletion.account,'a');assert.equal(deletion.jobId,'j1');assert.equal(deletion.expectedUpdatedAt,30);
  assert.deepEqual(rowTitles(h),['后端']);assert.match(find(h.widget(),'bh-notice').textContent,/已删除/);
});

test('浮窗没有按链接删除入口，卡片删除仍保留',async()=>{
  const d=data(),h=visualHarness(async message=>message.type==='INGEST'?{ok:true}:{ok:true,data:d});
  await h.deliver(snapshot());assert.equal(find(h.widget(),'bh-delete-toggle'),undefined);assert.equal(find(h.widget(),'bh-delete-input'),undefined);assert.equal(find(h.widget(),'bh-delete-form'),undefined);
  assert.ok(find(h.widget(),'bh-job-delete'));assert.ok(!h.widget().textContent.includes('按链接删除'));
});

test('编辑草稿时不执行删除，临时未入库的JD不能删除',async()=>{
  const sent=[],d=data();d.jobs[0].persisted=false;
  const h=visualHarness(async message=>{sent.push(message);return message.type==='INGEST'?{ok:true}:{ok:true,data:d};});
  await h.deliver(snapshot());
  let rows=all(h.widget(),'bh-job');assert.equal(find(rows[0],'bh-job-delete').disabled,true);
  d.jobs[0].persisted=true;await h.deliver({type:'CONVERSATION',account:'a',row:{id:'c1'}});
  await currentStatus(h).emit('click');const input=find(h.widget(),'bh-note-input');input.value='未保存草稿';await input.emit('input');
  rows=all(h.widget(),'bh-job');await find(rows[0],'bh-job-delete').emit('click');
  assert.ok(!sent.some(message=>message.type==='DELETE_JOB'));assert.equal(find(h.widget(),'bh-note-input').value,'未保存草稿');assert.match(find(h.widget(),'bh-notice').textContent,/请先保存或取消/);
});

test('从其他标签取消收藏后，切回职位页立即刷新浮窗',async()=>{
  let reads=0;const d=data();
  const h=visualHarness(async message=>{if(message.type==='INGEST')return{ok:true};reads++;return{ok:true,data:d};});
  await h.deliver({type:'PAGE_CONTEXT',account:'a',jobId:'j1',companyName:'示例公司',title:'前端'});
  h.visibility(true);d.jobs=d.jobs.filter(job=>job.id!=='j1');h.visibility(false);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(reads,2);assert.deepEqual(rowTitles(h),['后端']);
});

test('浮窗收藏标识独立于沟通状态，JD标题是安全的详情页链接',async()=>{
  const d=data();d.jobs[1].favorite=true;d.jobs[1].url='https://www.zhipin.com/job_detail/job-1.html?securityId=discard';d.jobs[0].url='javascript:alert(1)';
  const h=visualHarness(async message=>message.type==='INGEST'?{ok:true}:{ok:true,data:d});
  await h.deliver(snapshot());
  const rows=all(h.widget(),'bh-job'),link=find(rows[1],'bh-job-title');
  assert.equal(link.tagName,'a');assert.equal(link.href,'https://www.zhipin.com/job_detail/job-1.html');assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');
  assert.equal(find(rows[1],'bh-favorite').textContent,'已收藏');assert.equal(currentStatus(h).textContent,'附件简历请求已发送');
  assert.equal(find(rows[0],'bh-job-title').tagName,'span');
});

test('职位页浮窗只读展示已有公司记录，高亮当前JD并禁止编辑',async()=>{
  const sent=[],d=data();
  const h=visualHarness(async message=>{sent.push(message);return message.type==='INGEST'?{ok:true}:{ok:true,data:d};});
  await h.deliver({type:'PAGE_CONTEXT',account:'a',jobId:'j1',companyName:'示例公司',title:'前端'});
  assert.equal(sent.find(message=>message.type==='WIDGET_GET').preview,true);
  assert.deepEqual(rowTitles(h),['后端','前端']);
  assert.equal(currentStatus(h).disabled,true);
  assert.equal(find(h.widget(),'bh-company-line').children[1].disabled,true);
  assert.equal(find(h.widget(),'bh-job-note-edit'),undefined);
  assert.equal(find(h.widget(),'bh-notice').hidden,true);
  assert.doesNotMatch(h.widget().textContent,/仅查看|不会新增|当前浏览|当前 JD 已记录/);
  assert.doesNotMatch(h.widget().textContent,/仅查看|不会新增|不采集|当前浏览|当前 JD 已记录/);
  assert.ok(!/仅查看|浏览不会|当前浏览|当前 JD 已记录/.test(h.widget().textContent));
  assert.match(h.widget().textContent,/公司原备注/);
  await currentStatus(h).emit('click');
  assert.equal(find(h.widget(),'bh-editor'),undefined);
  await h.deliver(snapshot());
  assert.equal(currentStatus(h).disabled,false);
  assert.ok(find(h.widget(),'bh-job-note-edit'));
  assert.ok(!sent.some(message=>message.type.startsWith('SAVE_')));
});

test('职位页切换到未记录公司和未选中职位时清除高亮与旧公司记录',async()=>{
  const h=visualHarness(async message=>message.type==='INGEST'?{ok:true}:{ok:true,data:message.jobId==='j1'?data():{companyName:message.companyName,jobs:[]}});
  await h.deliver({type:'PAGE_CONTEXT',account:'a',jobId:'j1',companyName:'示例公司',title:'前端'});
  await h.deliver({type:'PAGE_CONTEXT',account:'a',jobId:'new',companyName:'新公司',title:'新职位'});
  assert.deepEqual(rowTitles(h),[]);
  assert.equal(find(h.widget(),'bh-company').textContent,'新公司');
  assert.equal(find(h.widget(),'bh-notice').textContent,'暂无已记录的 JD');
  assert.ok(!h.widget().textContent.includes('公司原备注'));
  await h.deliver({type:'PAGE_CONTEXT',account:'a'});
  assert.equal(find(h.widget(),'bh-company').textContent,'公司待识别');
});

test('浮窗保持后端对话时间顺序，只高亮当前JD而不将其置顶',async()=>{
  const queries=[],d=data();
  const h=visualHarness(async message=>{if(message.type==='INGEST')return{ok:true};queries.push(message.jobId);return{ok:true,data:d};});
  await h.deliver(snapshot());const w=h.widget(),rows=all(w,'bh-job');
  assert.equal(find(w,'bh-company').textContent,'示例公司');assert.ok(!w.textContent.includes('沟通助手'));
  assert.equal(rows.length,2);assert.equal(rows.filter(r=>r.attributes['aria-current']==='true').length,1);
  assert.deepEqual(rowTitles(h),['后端','前端']);assert.equal(rows[1].attributes['aria-current'],'true');assert.equal(currentStatus(h).textContent,'附件简历请求已发送');
  const target=currentStatus(h);
  await h.deliver({type:'CONVERSATION',account:'a',row:{id:'c2',jobId:'j2'}});assert.equal(queries.at(-1),'j1');
  assert.equal(currentStatus(h),target,'相同内容的后台刷新不能替换可点击控件');
});
test('切换当前JD、修改状态或标题都不会重新排列浮窗',async()=>{
  const d=data(),h=visualHarness(async m=>m.type==='INGEST'?{ok:true}:{ok:true,data:d});
  await h.deliver(snapshot());assert.deepEqual(rowTitles(h),['后端','前端']);
  d.jobs[0].current=true;d.jobs[1].current=false;d.jobs[1].status='passed';
  await h.deliver(snapshot('a','j2'));assert.deepEqual(rowTitles(h),['后端','前端']);assert.equal(all(h.widget(),'bh-job')[0].attributes['aria-current'],'true');
  d.jobs[0].title='Z 职位';d.jobs[1].title='A 职位';await h.deliver({type:'CONVERSATION',account:'a',row:{id:'c1'}});
  assert.deepEqual(rowTitles(h),['Z 职位','A 职位']);
});
test('浮窗展示最新简历系统提示，人工状态仍优先',async()=>{
  let manual=false;const d=data();
  const h=visualHarness(async message=>{if(message.type==='INGEST')return{ok:true};d.jobs[1]={...d.jobs[1],status:manual?'interviewing':'resume_event',manual};return{ok:true,data:d};});
  await h.deliver(snapshot());assert.equal(currentStatus(h).textContent,'附件简历请求已发送');
  manual=true;await h.deliver({type:'CONVERSATION',account:'a',row:{id:'c1'}});assert.equal(currentStatus(h).textContent,'面试中（手动）');
});
test('浮窗同时保存JD状态与备注，自动刷新和摄取不丢编辑内容',async()=>{
  const d=data(),sent=[];let reads=0;
  const h=visualHarness(async message=>{sent.push(message);if(message.type==='INGEST')return{ok:true};if(message.type==='SAVE_JOB'){d.jobs[1]={...d.jobs[1],status:message.status,manual:true,note:message.note};return{ok:true};}reads++;return{ok:true,data:d};});
  await h.deliver(snapshot());await currentStatus(h).emit('click');
  const form=find(h.widget(),'bh-editor'),input=find(form,'bh-note-input'),select=find(form,'bh-status-select');
  input.value='面试需要准备 <script>示例</script>';await input.emit('input');assert.equal(select.children.filter(o=>o.value==='interviewing').length,1);assert.ok(!select.children.some(o=>/^interview_/.test(o.value)));select.value='interviewing';await select.emit('change');
  h.tick();await h.deliver({type:'CONVERSATION',account:'a',row:{id:'c1'}});
  assert.equal(reads,1);assert.equal(find(h.widget(),'bh-note-input'),input);assert.match(input.value,/面试需要准备/);
  await form.emit('submit');const save=sent.find(m=>m.type==='SAVE_JOB');
  assert.equal(save.account,'a');assert.equal(save.jobId,'j1');assert.equal(save.status,'interviewing');assert.equal(save.note,input.value);
  assert.equal(find(h.widget(),'bh-editor'),undefined);assert.ok(h.widget().textContent.includes(input.value));assert.match(currentStatus(h).textContent,/面试中/);
});
test('只改状态不回写旧备注，只改备注不回写旧状态',async()=>{
  const d=data(),sent=[];
  const h=visualHarness(async m=>{if(m.type==='INGEST')return{ok:true};if(m.type==='SAVE_JOB'){sent.push(m);if(Object.hasOwn(m,'status')){d.jobs[1].status=m.status;d.jobs[1].manual=true;}if(Object.hasOwn(m,'note'))d.jobs[1].note=m.note;return{ok:true};}return{ok:true,data:d};});
  await h.deliver(snapshot());await currentStatus(h).emit('click');
  d.jobs[1].note='其他页面的新备注';let select=find(h.widget(),'bh-status-select');select.value='interviewing';await select.emit('change');await find(h.widget(),'bh-editor').emit('submit');
  assert.ok(!Object.hasOwn(sent[0],'note'));assert.equal(sent[0].expectedManualStatus,null);assert.equal(d.jobs[1].note,'其他页面的新备注');
  await currentStatus(h).emit('click');d.jobs[1].status='passed';let input=find(h.widget(),'bh-note-input');input.value='只修改备注';await input.emit('input');await find(h.widget(),'bh-editor').emit('submit');
  assert.ok(!Object.hasOwn(sent[1],'status'));assert.equal(sent[1].expectedNote,'其他页面的新备注');assert.equal(d.jobs[1].status,'passed');
});
test('旧保存响应不能删除切换回来后继续输入的新草稿',async()=>{
  const d=data(),sent=[];let complete;
  const h=visualHarness(async m=>{if(m.type==='INGEST')return{ok:true};if(m.type==='SAVE_JOB'){sent.push(m);if(sent.length===1)return new Promise(resolve=>{complete=()=>{d.jobs[1].note=m.note;resolve({ok:true});};});d.jobs[1].note=m.note;return{ok:true};}return{ok:true,data:d};});
  await h.deliver(snapshot());await currentStatus(h).emit('click');let input=find(h.widget(),'bh-note-input');input.value='先提交的备注';await input.emit('input');const saving=find(h.widget(),'bh-editor').emit('submit');
  await h.deliver({type:'SNAPSHOT',account:'a',selectedId:null,rows:[]});await h.deliver(snapshot());await currentStatus(h).emit('click');input=find(h.widget(),'bh-note-input');input.value='返回后继续输入的新草稿';await input.emit('input');
  complete();await saving;assert.equal(find(h.widget(),'bh-note-input').value,'返回后继续输入的新草稿');
  await h.deliver({type:'CONVERSATION',account:'a',row:{id:'c1'}});await find(h.widget(),'bh-editor').emit('submit');
  assert.equal(sent[1].expectedNote,'先提交的备注');assert.equal(d.jobs[1].note,'返回后继续输入的新草稿');
});
test('未修改时保存只关闭编辑器，不产生写操作',async()=>{
  const sent=[],d=data();const h=visualHarness(async m=>{sent.push(m);return m.type==='INGEST'?{ok:true}:{ok:true,data:d};});
  await h.deliver(snapshot());await currentStatus(h).emit('click');await find(h.widget(),'bh-editor').emit('submit');
  assert.equal(find(h.widget(),'bh-editor'),undefined);assert.ok(!sent.some(m=>m.type==='SAVE_JOB'));
});
test('公司备注单独保存，JD备注不受影响',async()=>{
  const d=data(),sent=[];
  const h=visualHarness(async m=>{sent.push(m);if(m.type==='INGEST')return{ok:true};if(m.type==='SAVE_COMPANY_NOTE'){d.companyNote=m.note;return{ok:true};}return{ok:true,data:d};});
  await h.deliver(snapshot());await find(h.widget(),'bh-company-line').children[1].emit('click');
  const form=find(h.widget(),'bh-editor'),input=find(form,'bh-note-input');input.value='公司沟通偏好';await input.emit('input');await form.emit('submit');
  const save=sent.find(m=>m.type==='SAVE_COMPANY_NOTE');assert.equal(save.companyId,'company-a');assert.equal(save.account,'a');assert.equal(save.note,'公司沟通偏好');
  assert.equal(d.jobs[1].note,'职位原备注');assert.ok(h.widget().textContent.includes('公司沟通偏好'));
});
test('保存失败保留草稿，切换上下文后返回可继续编辑',async()=>{
  const d=data();const h=visualHarness(async m=>m.type==='INGEST'?{ok:true}:m.type==='SAVE_JOB'?{ok:false,error:'模拟保存失败'}:{ok:true,data:d});
  await h.deliver(snapshot());await currentStatus(h).emit('click');let input=find(h.widget(),'bh-note-input');input.value='未保存草稿';await input.emit('input');
  await find(h.widget(),'bh-editor').emit('submit');assert.equal(find(h.widget(),'bh-note-input').value,'未保存草稿');assert.equal(find(h.widget(),'bh-save').disabled,false);assert.match(find(h.widget(),'bh-editor-feedback').textContent,/失败/);
  await h.deliver({type:'SNAPSHOT',account:'a',selectedId:null,rows:[]});await h.deliver(snapshot());await currentStatus(h).emit('click');
  assert.equal(find(h.widget(),'bh-note-input').value,'未保存草稿');
});
test('content 在后台返回后转发关联 ACK，异常也回传失败',async()=>{
  let finish;const h=harness(()=>new Promise(resolve=>{finish=resolve;}));const d={type:'CONVERSATION',account:'account',runId:'run',requestId:'request'};
  const pending=h.deliver(d);assert.equal(h.output.some(x=>x.type==='INGEST_ACK'),false);finish({ok:true});await pending;
  const ack=h.output.find(x=>x.type==='INGEST_ACK');assert.equal(ack.ok,true);assert.equal(ack.requestId,'request');assert.equal(ack.runId,'run');
  const failed=harness(async()=>{throw new Error('offline');});await failed.deliver(d);assert.equal(failed.output.find(x=>x.type==='INGEST_ACK').ok,false);
});
