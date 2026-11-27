import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {formatRelativeStatusDate} from '../../extension/src/status.ts';
import {browserHarness, flush} from './support/dom.js';

const source=await readFile(new URL('../../extension/dist/content.js',import.meta.url),'utf8');
const harness=sendMessage=>browserHarness(source,sendMessage);
const visualHarness=(sendMessage,options)=>browserHarness(source,sendMessage,options);
const find=(root,cls)=>root?.classList.contains(cls)?root:root?.querySelector('.'+cls)||undefined;
const all=(root,cls)=>[...(root?.classList.contains(cls)?[root]:[]),...(root?.querySelectorAll('.'+cls)||[])];
const currentJob=h=>all(h.widget(),'bh-job').find(row=>row.getAttribute('aria-current')==='true');
const currentStatus=h=>find(currentJob(h),'bh-job-status');
const currentNote=h=>find(currentJob(h),'bh-job-note-edit');
const statusOption=(h,value)=>all(currentJob(h),'bh-status-option').find(option=>option.value===value);
const statusDialog=h=>find(currentJob(h),'bh-status-dialog');
const rowTitles=h=>all(h.widget(),'bh-job').map(row=>find(row,'bh-job-title').textContent);
const snapshot=(account='a',jobId='j1')=>({type:'SNAPSHOT',account,selectedId:'c1',rows:[{id:'c1',jobId,companyName:'示例公司',jobTitle:jobId==='j1'?'前端':'后端'}]});
// The server returns the older JD first, while the current JD is the second row.
const data=()=>({companyId:'company-a',companyName:'示例公司',companyNote:'公司原备注',settings:{},jobs:[{id:'j2',title:'后端',persisted:true,updatedAt:20,firstConversationAt:10,status:'awaiting_self',note:''},{id:'j1',title:'前端',persisted:true,updatedAt:30,firstConversationAt:20,status:'resume_event',label:'附件简历请求已发送',manual:false,current:true,note:'职位原备注'}]});

test('未沟通的职位在浮窗显示待沟通', async () => {
  const value=data();
  value.jobs[1].status='awaiting_contact';
  const h=harness(async()=>({ok:true,data:value}));
  await h.deliver(snapshot());
  assert.equal(currentStatus(h).textContent,'待沟通');
});

test('浮窗打开当前账号的合并看板', async () => {
  const opened = [];
  const h = harness(async message => {
    if (message.type === 'OPEN_DASHBOARD') opened.push(message);
    return {ok: true, data: data()};
  });
  await h.deliver(snapshot());
  const buttons = all(h.widget(), 'bh-overview');
  assert.deepEqual(buttons.map(button => button.textContent), ['BoDesk']);
  for (const button of buttons) await button.emit('click');
  assert.deepEqual(opened, [
    {type: 'OPEN_DASHBOARD', account: 'a'},
  ]);
});

test('浮窗收起时隐藏内容，重新展开保留备注草稿，切换职位也保持收起状态',async()=>{
  const h=visualHarness(async message=>message.type==='INGEST'?{ok:true}:{ok:true,data:data()});
  await h.deliver(snapshot());
  const toggle=find(h.widget(),'bh-widget-toggle');
  const body=h.document.getElementById(toggle.getAttribute('aria-controls'));
  const company=find(h.widget(),'bh-company');
  assert.equal(toggle.getAttribute('aria-expanded'),'true');
  assert.equal(toggle.getAttribute('aria-label'),'收起浮窗');
  assert.equal(body.hidden,false);

  await currentNote(h).emit('click');
  const input=find(h.widget(),'bh-note-input');
  input.value='未保存的备注';
  await input.emit('input');
  await toggle.emit('click');
  assert.equal(toggle.getAttribute('aria-expanded'),'false');
  assert.equal(toggle.getAttribute('aria-label'),'展开浮窗');
  assert.equal(toggle.textContent,'BoDesk');
  assert.equal(body.hidden,true);
  assert.equal(company.hidden,true);
  assert.equal(find(h.widget(),'bh-note-input'),undefined);

  await toggle.emit('click');
  assert.equal(toggle.getAttribute('aria-expanded'),'true');
  assert.equal(toggle.textContent,'');
  assert.equal(body.hidden,false);
  assert.equal(company.hidden,false);
  await currentNote(h).emit('click');
  assert.equal(find(h.widget(),'bh-note-input').value,'未保存的备注');

  await toggle.emit('click');
  await h.deliver(snapshot('a','j2'));
  assert.equal(toggle.getAttribute('aria-expanded'),'false');
  assert.equal(body.hidden,true);
});

test('拖动浮窗后保存位置，新页面恢复，窗口缩小时保持可见', async () => {
  const stored = {};
  let saves = 0;
  const storage = {local: {
    get: async key => ({[key]: stored[key]}),
    set: async values => {Object.assign(stored, values); saves++;},
  }};
  async function openPage(url) {
    const h = visualHarness(async () => ({ok: true, data: data()}), {storage, url});
    const resize = (width, height) => {
      Object.defineProperties(h.document.documentElement, {clientWidth: {configurable: true, value: width}, clientHeight: {configurable: true, value: height}});
      h.window.dispatchEvent(new h.window.Event('resize'));
    };
    resize(900, 700);
    h.widget().getBoundingClientRect = () => ({left: 522, top: 482, width: 360, height: 200});
    await h.deliver(snapshot());
    return {h, resize};
  }
  const {h} = await openPage();
  const grip = find(h.widget(), 'bh-widget-drag');
  grip.setPointerCapture = () => {};
  const pointer = (type, clientX, clientY) => grip.dispatchEvent(new h.window.PointerEvent(type, {pointerId: 1, isPrimary: true, clientX, clientY, button: 0}));

  pointer('pointerdown', 544, 505);
  pointer('pointermove', 244, 305);
  assert.equal(h.widget().style.left, '222px');
  assert.equal(h.widget().style.top, '282px');
  assert.equal(saves, 0);
  pointer('pointerup', 244, 305);
  assert.equal(saves, 1);

  const {h: refreshed, resize} = await openPage();
  assert.equal(refreshed.widget().style.left, '222px');
  assert.equal(refreshed.widget().style.top, '282px');
  resize(500, 400);
  assert.equal(refreshed.widget().style.left, '140px');
  assert.equal(refreshed.widget().style.top, '200px');
  resize(900, 700);
  assert.equal(refreshed.widget().style.left, '222px');
  assert.equal(refreshed.widget().style.top, '282px');
  assert.equal(saves, 1);

  const {h: mock} = await openPage('http://127.0.0.1:4173/web/geek/chat');
  assert.equal(mock.widget().style.left, '');
  assert.equal(mock.widget().style.top, '');
});

test('浮窗按发送方显示人工消息预览并保留完整的纯文本', async () => {
  const details = data();
  const longMessage = '这是较长的消息'.repeat(40) + '\n<img src=x onerror="window.executed=true">';
  details.jobs[0].latestMessage = {text:longMessage,direction:'out',receipt:'read'};
  details.jobs[1].latestMessage = {text:'可以约下周沟通',direction:'in',receipt:'read'};
  const h = visualHarness(async message => message.type==='INGEST' ? {ok:true} : {ok:true,data:details});
  await h.deliver(snapshot());
  const [outgoing, incoming] = all(h.widget(),'bh-message-preview');
  assert.ok(outgoing.classList.contains('bh-message-out'));
  assert.ok(incoming.classList.contains('bh-message-in'));
  assert.equal(outgoing.getAttribute('aria-label'), '最后一条对话');
  const outgoingSender = find(outgoing, 'bh-message-sender');
  const incomingSender = find(incoming, 'bh-message-sender');
  assert.equal(outgoingSender.textContent, '自己');
  assert.equal(outgoingSender.lastChild, outgoingSender.querySelector('.bh-icon'));
  assert.equal(incomingSender.textContent, '对方');
  assert.equal(incomingSender.firstChild, incomingSender.querySelector('.bh-icon'));
  const outgoingReceipt = outgoing.querySelector('[data-receipt="read"]');
  assert.equal(outgoingReceipt.textContent, '已读');
  assert.equal(outgoingSender.parentElement, outgoingReceipt.parentElement);
  assert.equal(incoming.querySelector('.message-receipt'),null);
  assert.equal(find(outgoing,'bh-message-text').textContent,longMessage);
  assert.equal(outgoing.querySelector('img'), null);
});

test('点击状态直接显示选项，确认后才保存手动状态或恢复自动',async()=>{
  const sent=[],d=data();
  const h=visualHarness(async message=>{
    sent.push(message);
    if(message.type==='INGEST')return{ok:true};
    if(message.type==='SAVE_JOB'){d.jobs[1].manual=message.status!=='auto';d.jobs[1].status=d.jobs[1].manual?message.status:'resume_event';return{ok:true};}
    return{ok:true,data:d};
  });
  await h.deliver(snapshot());await currentStatus(h).emit('click');
  const reject=statusOption(h,'communication_rejected');
  assert.equal(reject.textContent,'对方拒绝沟通');
  assert.equal(currentStatus(h).getAttribute('aria-expanded'),'true');
  await reject.emit('click');
  assert.equal(statusDialog(h).open,true);
  assert.match(statusDialog(h).textContent,/前端.*对方拒绝沟通/);
  assert.ok(!sent.some(message=>message.type==='SAVE_JOB'));
  await find(statusDialog(h),'bh-cancel').emit('click');
  assert.equal(statusDialog(h),undefined);
  assert.ok(!sent.some(message=>message.type==='SAVE_JOB'));
  assert.equal(currentStatus(h).textContent,'附件简历请求已发送');
  await statusOption(h,'communication_rejected').emit('click');
  await find(statusDialog(h),'bh-save').emit('click');
  assert.equal(sent.find(message=>message.type==='SAVE_JOB').status,'communication_rejected');
  assert.equal(statusDialog(h),undefined);
  assert.equal(currentStatus(h).textContent,'对方拒绝沟通（手动）');
  await h.tick();assert.equal(currentStatus(h).textContent,'对方拒绝沟通（手动）');
  await currentStatus(h).emit('click');assert.equal(statusOption(h,'communication_rejected').disabled,true);
  await statusOption(h,'auto').emit('click');
  assert.match(statusDialog(h).textContent,/跟随自动判断/);
  await find(statusDialog(h),'bh-save').emit('click');
  assert.equal(currentStatus(h).textContent,'附件简历请求已发送');
});

test('职位页的JD卡片可直接删除，取消确认不写入，成功后刷新浮窗',async()=>{
  const sent=[],d=data();
  const h=visualHarness(async message=>{sent.push(message);if(message.type==='INGEST')return{ok:true};if(message.type==='DELETE_JOB'){d.jobs=d.jobs.filter(job=>job.id!==message.jobId);return{ok:true};}return{ok:true,data:d};});
  await h.deliver({type:'PAGE_CONTEXT',account:'a',jobId:'j1',companyName:'示例公司',title:'前端'});
  const heading=find(currentJob(h),'bh-job-heading-row');
  const remove=find(heading,'bh-job-delete');
  assert.ok(find(heading,'bh-job-title'));
  assert.ok(find(heading,'bh-job-note-edit'));
  assert.equal(remove.disabled,false);await remove.emit('click');assert.ok(!sent.some(message=>message.type==='DELETE_JOB'));
  await find(find(h.widget(),'bh-delete-dialog'),'bh-cancel').emit('click');
  assert.ok(!sent.some(message=>message.type==='DELETE_JOB'));
  await remove.emit('click');await find(h.widget(),'bh-confirm-delete').emit('click');
  const deletion=sent.find(message=>message.type==='DELETE_JOB');
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
  await currentNote(h).emit('click');const input=find(h.widget(),'bh-note-input');input.value='未保存草稿';await input.emit('input');
  rows=all(h.widget(),'bh-job');await find(rows[0],'bh-job-delete').emit('click');
  assert.ok(!sent.some(message=>message.type==='DELETE_JOB'));assert.equal(find(h.widget(),'bh-note-input').value,'未保存草稿');assert.match(find(h.widget(),'bh-notice').textContent,/请先保存或取消/);
});

test('从其他标签取消收藏后，切回职位页立即刷新浮窗',async()=>{
  let reads=0;const d=data();
  const h=visualHarness(async message=>{if(message.type==='INGEST')return{ok:true};reads++;return{ok:true,data:d};});
  await h.deliver({type:'PAGE_CONTEXT',account:'a',jobId:'j1',companyName:'示例公司',title:'前端'});
  await h.visibility(true);d.jobs=d.jobs.filter(job=>job.id!=='j1');await h.visibility(false);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(reads,2);assert.deepEqual(rowTitles(h),['后端']);
});

test('浮窗收藏标识独立于沟通状态，JD标题是安全的详情页链接',async()=>{
  const d=data();d.jobs[1].favorite=true;d.jobs[1].url='https://www.zhipin.com/job_detail/job-1.html?securityId=discard';d.jobs[0].url='javascript:alert(1)';
  const h=visualHarness(async message=>message.type==='INGEST'?{ok:true}:{ok:true,data:d});
  await h.deliver(snapshot());
  const rows=all(h.widget(),'bh-job'),link=find(rows[1],'bh-job-title');
  assert.equal(link.tagName,'A');assert.equal(link.href,'https://www.zhipin.com/job_detail/job-1.html');assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');
  assert.equal(find(rows[1],'bh-favorite').getAttribute('aria-label'),'已收藏职位');assert.equal(currentStatus(h).textContent,'附件简历请求已发送');
  assert.equal(find(rows[0],'bh-job-title').tagName,'SPAN');
});

test('职位页浮窗复用公司备注、JD 备注和状态确认',async()=>{
  const sent=[],d=data();
  const h=visualHarness(async message=>{
    sent.push(message);
    if(message.type==='SAVE_COMPANY_NOTE')d.companyNote=message.note;
    if(message.type==='SAVE_JOB'){
      const job=d.jobs.find(item=>item.id===message.jobId);
      if(Object.hasOwn(message,'note'))job.note=message.note;
      if(message.status){job.status=message.status;job.manual=true;}
    }
    return message.type==='WIDGET_GET'?{ok:true,data:d}:{ok:true};
  });
  await h.deliver({type:'PAGE_CONTEXT',account:'a',jobId:'j1',companyName:'示例公司',title:'前端'});
  assert.equal(sent.find(message=>message.type==='WIDGET_GET').preview,true);
  assert.deepEqual(rowTitles(h),['后端','前端']);
  assert.equal(currentStatus(h).disabled,false);
  assert.equal(find(h.widget(),'bh-company-note-edit').disabled,false);
  assert.ok(currentNote(h));
  assert.equal(find(h.widget(),'bh-notice').hidden,true);
  assert.match(h.widget().textContent,/公司原备注/);
  await currentStatus(h).emit('click');
  await statusOption(h,'passed').emit('click');
  assert.ok(!sent.some(message=>message.type.startsWith('SAVE_')));
  await find(statusDialog(h),'bh-save').emit('click');
  assert.match(currentStatus(h).textContent,/面试通过/);

  for(const [button,note] of [[find(h.widget(),'bh-company-note-edit'),'详情公司备注'],[currentNote(h),'详情职位备注']]){
    await button.emit('click');
    const input=find(h.widget(),'bh-note-input');
    input.value=note;
    await input.emit('input');
    await find(h.widget(),'bh-editor').emit('submit');
    assert.match(h.widget().textContent,new RegExp(note));
  }
  assert.deepEqual(sent.filter(message=>message.type.startsWith('SAVE_')).map(message=>[message.type,message.status||message.note]),
    [['SAVE_JOB','passed'],['SAVE_COMPANY_NOTE','详情公司备注'],['SAVE_JOB','详情职位备注']]);
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
  assert.equal(rows.length,2);assert.equal(rows.filter(r=>r.getAttribute('aria-current')==='true').length,1);
  assert.deepEqual(rowTitles(h),['后端','前端']);assert.equal(rows[1].getAttribute('aria-current'),'true');assert.equal(currentStatus(h).textContent,'附件简历请求已发送');
  const target=currentStatus(h);
  await h.deliver({type:'CONVERSATION',account:'a',row:{id:'c2',jobId:'j2'}});assert.equal(queries.at(-1),'j1');
  assert.equal(currentStatus(h),target,'相同内容的后台刷新不能替换可点击控件');
});
test('切换当前JD、修改状态或标题都不会重新排列浮窗',async()=>{
  const d=data(),h=visualHarness(async m=>m.type==='INGEST'?{ok:true}:{ok:true,data:d});
  await h.deliver(snapshot());assert.deepEqual(rowTitles(h),['后端','前端']);
  d.jobs[0].current=true;d.jobs[1].current=false;d.jobs[1].status='passed';
  await h.deliver(snapshot('a','j2'));assert.deepEqual(rowTitles(h),['后端','前端']);assert.equal(all(h.widget(),'bh-job')[0].getAttribute('aria-current'),'true');
  d.jobs[0].title='Z 职位';d.jobs[1].title='A 职位';await h.deliver({type:'CONVERSATION',account:'a',row:{id:'c1'}});
  assert.deepEqual(rowTitles(h),['Z 职位','A 职位']);
});
test('当前和其他职位使用相同的卡片结构，状态可直接选择并点浮窗外关闭',async()=>{
  const sent = [];
  const details = data();
  for (const job of details.jobs) {
    Object.assign(job, {favorite: true, note: '职位备注', latestMessage: {direction: 'in', text: '约时间沟通'}});
  }
  const h = visualHarness(async message => {
    sent.push(message);
    return message.type === 'INGEST' ? {ok: true} : {ok: true, data: details};
  });
  await h.deliver(snapshot());
  const [relatedJob, activeJob] = all(h.widget(), 'bh-job');
  const childClasses = job => Array.from(job.children, child => child.className);
  assert.deepEqual(childClasses(relatedJob), childClasses(activeJob));
  for (const job of [relatedJob, activeJob]) {
    for (const className of ['bh-favorite', 'bh-message-preview', 'bh-job-note-edit', 'bh-note-text']) {
      const element = find(job, className);
      assert.ok(element && !element.closest('[hidden]'), className);
    }
  }
  const status = find(relatedJob, 'bh-job-status');
  await status.emit('click');
  assert.ok(find(relatedJob, 'bh-status-picker'));
  h.document.body.dispatchEvent(new h.window.PointerEvent('pointerdown', {bubbles: true}));
  await flush();
  assert.equal(status.getAttribute('aria-expanded'), 'false');
  assert.ok(!sent.some(message => message.type === 'SAVE_JOB'));
});
test('浮窗展示最新简历系统提示，人工状态仍优先',async()=>{
  let manual=false;const d=data();
  const h=visualHarness(async message=>{if(message.type==='INGEST')return{ok:true};d.jobs[1]={...d.jobs[1],status:manual?'interviewing':'resume_event',manual};return{ok:true,data:d};});
  await h.deliver(snapshot());assert.equal(currentStatus(h).textContent,'附件简历请求已发送');
  manual=true;await h.deliver({type:'CONVERSATION',account:'a',row:{id:'c1'}});assert.equal(currentStatus(h).textContent,'面试中（手动）');
});
test('状态确认独立于备注编辑，切换入口保留备注草稿',async()=>{
  const d=data(),sent=[];let reads=0;
  const h=visualHarness(async message=>{
    if(message.type==='INGEST')return{ok:true};
    if(message.type==='SAVE_JOB'){
      sent.push(message);
      if(Object.hasOwn(message,'status'))Object.assign(d.jobs[1],{status:message.status,manual:true});
      if(Object.hasOwn(message,'note'))d.jobs[1].note=message.note;
      return{ok:true};
    }
    reads++;return{ok:true,data:d};
  });
  await h.deliver(snapshot());
  await currentNote(h).emit('click');
  const input=find(h.widget(),'bh-note-input');
  const note='面试需要准备 <script>示例</script>';
  assert.equal(find(h.widget(),'bh-status-picker'),undefined);
  input.value=note;await input.emit('input');
  h.tick();await h.deliver({type:'CONVERSATION',account:'a',row:{id:'c1'}});
  assert.equal(reads,1);assert.equal(find(h.widget(),'bh-note-input'),input);assert.equal(input.value,note);

  await currentStatus(h).emit('click');
  const options=all(currentJob(h),'bh-status-option');
  assert.equal(find(h.widget(),'bh-note-input'),undefined);
  assert.equal(find(currentJob(h),'bh-note-text').textContent,'职位原备注');
  assert.equal(options.filter(option=>option.value==='interviewing').length,1);
  assert.ok(!options.some(option=>/^interview_/.test(option.value)));
  await statusOption(h,'interviewing').emit('click');
  await find(statusDialog(h),'bh-save').emit('click');
  assert.equal(sent[0].account,'a');assert.equal(sent[0].jobId,'j1');assert.equal(sent[0].status,'interviewing');
  assert.ok(!Object.hasOwn(sent[0],'note'));assert.equal(d.jobs[1].note,'职位原备注');

  await currentNote(h).emit('click');
  assert.equal(find(h.widget(),'bh-note-input').value,note);
  await find(h.widget(),'bh-editor').emit('submit');
  assert.equal(sent[1].note,note);assert.ok(!Object.hasOwn(sent[1],'status'));
  assert.equal(find(h.widget(),'bh-editor'),undefined);assert.ok(h.widget().textContent.includes(note));assert.match(currentStatus(h).textContent,/面试中/);
});
test('只改状态不回写旧备注，只改备注不回写旧状态',async()=>{
  const d=data(),sent=[];
  const h=visualHarness(async m=>{if(m.type==='INGEST')return{ok:true};if(m.type==='SAVE_JOB'){sent.push(m);if(Object.hasOwn(m,'status')){d.jobs[1].status=m.status;d.jobs[1].manual=true;}if(Object.hasOwn(m,'note'))d.jobs[1].note=m.note;return{ok:true};}return{ok:true,data:d};});
  await h.deliver(snapshot());await currentStatus(h).emit('click');
  d.jobs[1].note='其他页面的新备注';await statusOption(h,'interviewing').emit('click');await find(statusDialog(h),'bh-save').emit('click');
  assert.ok(!Object.hasOwn(sent[0],'note'));assert.equal(sent[0].expectedManualStatus,null);assert.equal(d.jobs[1].note,'其他页面的新备注');
  await currentNote(h).emit('click');d.jobs[1].status='passed';let input=find(h.widget(),'bh-note-input');input.value='只修改备注';await input.emit('input');await find(h.widget(),'bh-editor').emit('submit');
  assert.ok(!Object.hasOwn(sent[1],'status'));assert.equal(sent[1].expectedNote,'其他页面的新备注');assert.equal(d.jobs[1].status,'passed');
});
test('旧保存响应不能删除切换回来后继续输入的新草稿',async()=>{
  const d=data(),sent=[];let complete;
  const h=visualHarness(async m=>{if(m.type==='INGEST')return{ok:true};if(m.type==='SAVE_JOB'){sent.push(m);if(sent.length===1)return new Promise(resolve=>{complete=()=>{d.jobs[1].note=m.note;resolve({ok:true});};});d.jobs[1].note=m.note;return{ok:true};}return{ok:true,data:d};});
  await h.deliver(snapshot());await currentNote(h).emit('click');let input=find(h.widget(),'bh-note-input');input.value='先提交的备注';await input.emit('input');const saving=find(h.widget(),'bh-editor').emit('submit');
  await h.deliver({type:'SNAPSHOT',account:'a',selectedId:null,rows:[]});await h.deliver(snapshot());await currentNote(h).emit('click');input=find(h.widget(),'bh-note-input');input.value='返回后继续输入的新草稿';await input.emit('input');
  complete();await saving;assert.equal(find(h.widget(),'bh-note-input').value,'返回后继续输入的新草稿');
  await h.deliver({type:'CONVERSATION',account:'a',row:{id:'c1'}});await find(h.widget(),'bh-editor').emit('submit');
  assert.equal(sent[1].expectedNote,'先提交的备注');assert.equal(d.jobs[1].note,'返回后继续输入的新草稿');
});
test('当前状态不能重复选择，未修改的备注也不产生写操作',async()=>{
  const sent=[],d=data();const h=visualHarness(async m=>{sent.push(m);return m.type==='INGEST'?{ok:true}:{ok:true,data:d};});
  await h.deliver(snapshot());await currentStatus(h).emit('click');
  assert.equal(statusOption(h,'auto').disabled,true);
  await statusOption(h,'auto').emit('click');assert.equal(statusDialog(h),undefined);
  await currentNote(h).emit('click');await find(h.widget(),'bh-editor').emit('submit');
  assert.equal(find(h.widget(),'bh-editor'),undefined);assert.ok(!sent.some(m=>m.type==='SAVE_JOB'));
});

test('状态更新失败时确认弹窗保留选项，允许重试',async()=>{
  const d=data();let attempts=0;
  const h=visualHarness(async message=>{
    if(message.type==='INGEST')return{ok:true};
    if(message.type==='SAVE_JOB'){
      if(++attempts===1)return{ok:false,error:'模拟状态保存失败'};
      Object.assign(d.jobs[1],{status:message.status,manual:true});return{ok:true};
    }
    return{ok:true,data:d};
  });
  await h.deliver(snapshot());await currentStatus(h).emit('click');await statusOption(h,'interviewing').emit('click');
  await find(statusDialog(h),'bh-save').emit('click');
  assert.equal(statusDialog(h).open,true);
  assert.equal(statusDialog(h).querySelector('[role="alert"]').textContent,'模拟状态保存失败');
  assert.equal(currentStatus(h).textContent,'附件简历请求已发送');
  await find(statusDialog(h),'bh-save').emit('click');
  assert.equal(statusDialog(h),undefined);assert.equal(currentStatus(h).textContent,'面试中（手动）');
});
test('公司备注单独保存，JD备注不受影响',async()=>{
  const d=data(),sent=[];
  const h=visualHarness(async m=>{sent.push(m);if(m.type==='INGEST')return{ok:true};if(m.type==='SAVE_COMPANY_NOTE'){d.companyNote=m.note;return{ok:true};}return{ok:true,data:d};});
  await h.deliver(snapshot());await find(h.widget(),'bh-company-note-edit').emit('click');
  const form=find(h.widget(),'bh-editor'),input=find(form,'bh-note-input');
  assert.ok(form.closest('.bh-layer'));
  assert.equal(find(find(h.widget(),'bh-company-notes'),'bh-note-text').textContent,'公司原备注');
  input.value='公司沟通偏好';await input.emit('input');await form.emit('submit');
  const save=sent.find(m=>m.type==='SAVE_COMPANY_NOTE');assert.equal(save.companyId,'company-a');assert.equal(save.account,'a');assert.equal(save.note,'公司沟通偏好');
  assert.equal(d.jobs[1].note,'职位原备注');assert.ok(h.widget().textContent.includes('公司沟通偏好'));
});
test('公司垃圾桶打开确认浮层，确认后才删除并隐藏公司操作',async()=>{
  const sent=[];
  let details={...data(),companyPersisted:true};
  const h=visualHarness(async message=>{
    sent.push(message);
    if(message.type==='DELETE_COMPANY')details={companyName:'示例公司',companyDeleted:true,jobs:[]};
    return {ok:true,data:details};
  });
  await h.deliver(snapshot());
  const remove=find(h.widget(),'bh-company-delete');
  await remove.emit('click');
  const dialog=find(h.widget(),'bh-delete-dialog');
  assert.equal(dialog.open,true);
  assert.match(dialog.textContent,/旗下所有 JD/);
  assert.ok(!sent.some(message=>message.type==='DELETE_COMPANY'));
  assert.equal(all(h.widget(),'bh-job').length,2);
  await find(dialog,'bh-confirm-delete').emit('click');
  assert.deepEqual(sent.find(message=>message.type==='DELETE_COMPANY'),{type:'DELETE_COMPANY',account:'a',companyId:'company-a',expectedNote:'公司原备注'});
  assert.equal(find(h.widget(),'bh-company-delete'),undefined);
  assert.equal(all(h.widget(),'bh-job').length,0);
});
test('保存失败保留草稿，切换上下文后返回可继续编辑',async()=>{
  const d=data();const h=visualHarness(async m=>m.type==='INGEST'?{ok:true}:m.type==='SAVE_JOB'?{ok:false,error:'模拟保存失败'}:{ok:true,data:d});
  await h.deliver(snapshot());await currentNote(h).emit('click');let input=find(h.widget(),'bh-note-input');input.value='未保存草稿';await input.emit('input');
  await find(h.widget(),'bh-editor').emit('submit');assert.equal(find(h.widget(),'bh-note-input').value,'未保存草稿');assert.equal(find(h.widget(),'bh-save').disabled,false);assert.match(find(h.widget(),'bh-editor-feedback').textContent,/失败/);
  await h.deliver({type:'SNAPSHOT',account:'a',selectedId:null,rows:[]});await h.deliver(snapshot());await currentNote(h).emit('click');
  assert.equal(find(h.widget(),'bh-note-input').value,'未保存草稿');
});
test('content 在后台返回后转发关联 ACK，异常也回传失败',async()=>{
  let finish;const h=harness(()=>new Promise(resolve=>{finish=resolve;}));const d={type:'CONVERSATION',account:'account',runId:'run',requestId:'request'};
  const pending=h.deliver(d);assert.equal(h.output.some(x=>x.type==='INGEST_ACK'),false);finish({ok:true});await pending;
  const ack=h.output.find(x=>x.type==='INGEST_ACK');assert.equal(ack.ok,true);assert.equal(ack.requestId,'request');assert.equal(ack.runId,'run');
  const failed=harness(async()=>{throw new Error('offline');});await failed.deliver(d);assert.equal(failed.output.find(x=>x.type==='INGEST_ACK').ok,false);
});
test('浮窗在加载、保存和删除挂起期间呈现 loading 与 pending 状态，完成后恢复', async () => {
  let deferGet = true;
  let finishGet;
  let finishSave;
  let finishDelete;
  const d = data();
  d.jobs[1].persisted = true;
  const h = visualHarness(async message => {
    if (message.type === 'INGEST') return {ok: true};
    if (message.type === 'WIDGET_GET') return deferGet ? new Promise(resolve => {finishGet = resolve;}) : {ok: true, data: d};
    if (message.type === 'SAVE_JOB') return new Promise(resolve => {finishSave = resolve;});
    if (message.type === 'DELETE_JOB') return new Promise(resolve => {finishDelete = resolve;});
    return {ok: true, data: d};
  });
  const pendingSnapshot = h.deliver(snapshot());
  await flush();
  assert.ok(find(h.widget(), 'bh-skeleton-card'));
  const notice = find(h.widget(), 'bh-notice');
  assert.equal(notice.getAttribute('data-loading'), 'true');
  assert.equal(notice.textContent, '正在读取职位状态…');
  assert.ok(notice.querySelector('.bh-spinner svg'));
  deferGet = false;
  finishGet({ok: true, data: d});
  await pendingSnapshot;
  assert.equal(find(h.widget(), 'bh-skeleton-card'), undefined);
  assert.equal(notice.getAttribute('data-loading'), null);

  await currentNote(h).emit('click');
  const input = find(h.widget(), 'bh-note-input');
  input.value = '新备注';
  await input.emit('input');
  const saveButton = find(h.widget(), 'bh-save');
  const savingNote = find(h.widget(), 'bh-editor').emit('submit');
  await flush();
  assert.equal(saveButton.disabled, true);
  assert.equal(saveButton.getAttribute('aria-busy'), 'true');
  assert.equal(saveButton.textContent, '正在保存…');
  assert.ok(saveButton.querySelector('.bh-spinner svg'));
  finishSave({ok: true});
  await savingNote;
  assert.equal(find(h.widget(), 'bh-editor'), undefined);

  await find(currentJob(h), 'bh-job-delete').emit('click');
  const dialog = find(h.widget(), 'bh-delete-dialog');
  const deleteButton = find(dialog, 'bh-confirm-delete');
  const deleting = deleteButton.emit('click');
  await flush();
  assert.equal(deleteButton.disabled, true);
  assert.equal(deleteButton.getAttribute('aria-busy'), 'true');
  assert.equal(deleteButton.textContent, '正在删除…');
  assert.ok(deleteButton.querySelector('.bh-spinner svg'));
  d.jobs = [d.jobs[0]];
  finishDelete({ok: true});
  await deleting;
  assert.equal(find(h.widget(), 'bh-delete-dialog'), undefined);
});

test('formatRelativeStatusDate 按日历与月份边界返回 7 档状态更新标签', () => {
  const now = new Date(2026, 10, 27, 9, 0, 0).getTime();
  const midnight = new Date(2026, 10, 27, 0, 0, 0).getTime();
  const day = 86400_000;
  assert.equal(formatRelativeStatusDate(undefined, now), '');
  assert.equal(formatRelativeStatusDate(0, now), '');
  assert.equal(formatRelativeStatusDate(-10, now), '');
  assert.equal(formatRelativeStatusDate(NaN, now), '');
  assert.equal(formatRelativeStatusDate(now, now), '当天');
  assert.equal(formatRelativeStatusDate(midnight, now), '当天');
  assert.equal(formatRelativeStatusDate(midnight - 1, now), '1 天内');
  assert.equal(formatRelativeStatusDate(midnight - day, now), '1 天内');
  assert.equal(formatRelativeStatusDate(midnight - day - 1, now), '3 天内');
  assert.equal(formatRelativeStatusDate(midnight - 3 * day, now), '3 天内');
  assert.equal(formatRelativeStatusDate(midnight - 3 * day - 1, now), '1 周内');
  assert.equal(formatRelativeStatusDate(midnight - 7 * day, now), '1 周内');
  assert.equal(formatRelativeStatusDate(midnight - 7 * day - 1, now), '1 周前');
  assert.equal(formatRelativeStatusDate(new Date(2026, 9, 27, 0, 0, 0).getTime(), now), '1 周前');
  assert.equal(formatRelativeStatusDate(new Date(2026, 9, 27, 0, 0, 0).getTime() - 1, now), '1 个月前');
  assert.equal(formatRelativeStatusDate(new Date(2026, 7, 27, 0, 0, 0).getTime(), now), '1 个月前');
  assert.equal(formatRelativeStatusDate(new Date(2026, 7, 27, 0, 0, 0).getTime() - 1, now), '3 个月前');
  assert.equal(formatRelativeStatusDate(new Date(2026, 0, 1, 0, 0, 0).getTime(), now), '3 个月前');
});

test('浮窗状态行在有 statusAt 时展示相对状态日期并在缺失时省略', async () => {
  const now = Date.now();
  const day = 86400_000;
  const d = data();
  d.jobs = [
    {id: 'j-today', title: '今日职位', persisted: true, status: 'awaiting_self', statusAt: now - 60_000, current: true, note: ''},
    {id: 'j-3d', title: '三天职位', persisted: true, status: 'interviewing', manual: true, statusAt: now - 2 * day, note: ''},
    {id: 'j-none', title: '无时间职位', persisted: true, status: 'awaiting_contact', note: ''},
  ];
  const h = visualHarness(async message => message.type === 'INGEST' ? {ok: true} : {ok: true, data: d});
  await h.deliver(snapshot('a', 'j-today'));
  const rows = all(h.widget(), 'bh-job');
  const firstDate = find(rows[0], 'bh-job-status-date');
  assert.equal(firstDate.tagName, 'TIME');
  assert.equal(firstDate.textContent, '当天');
  assert.match(firstDate.getAttribute('title'), /^状态更新于 /);
  assert.equal(find(rows[0], 'bh-job-status-row').contains(firstDate), true);
  const secondDate = find(rows[1], 'bh-job-status-date');
  assert.equal(secondDate.textContent, '3 天内');
  assert.match(secondDate.getAttribute('title'), /^手动设置于 /);
  assert.equal(find(rows[2], 'bh-job-status-date'), undefined);
});
