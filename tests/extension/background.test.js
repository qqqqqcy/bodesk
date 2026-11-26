import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';

const A='a'.repeat(24), B='b'.repeat(24);
let instance=0;
async function harness({db=new IDBFactory(),onSend}={}) {
  globalThis.indexedDB=db;
  if (!globalThis.crypto) globalThis.crypto=webcrypto;
  let listener;
  const tabs=[], sent=[], handlers={}, queries=[], created=[],broadcasts=[];
  const event=name=>({addListener(fn) {handlers[name]=fn;}});
  globalThis.chrome={
    runtime:{getURL:path=>`chrome-extension://test/${path}`,onMessage:{addListener(fn){listener=fn;}}},
    tabs:{onRemoved:event('removed'),onUpdated:event('updated'),query:async query=>{queries.push(query);return tabs;},sendMessage:async(id,message)=>{sent.push({id,message});return onSend?onSend(id,message):message.type==='ACCOUNT_INFO'?{account:B}:{ok:true};},create:async options=>{created.push(options);}},
    action:{onClicked:event('action')}
  };
  await import(`../../extension/dist/background.js?test=${instance++}`);
  const ui={url:'chrome-extension://test/dist/dashboard.html'};
  globalThis.chrome.runtime.sendMessage=async message=>{broadcasts.push(message);};
  const site={url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}};
  const send=(message,sender=ui)=>new Promise(resolve=>{assert.equal(listener(message,sender,resolve),true);});
  const ingest=(data,sender=site)=>send({type:'INGEST',data},sender);
  const bind=async(account,sender)=>{const result=await ingest({type:'PAGE_CONTEXT',account},sender);assert.equal(result.ok,true,result.error);};
  const get=async(account)=>{const result=await send({type:'DB_GET',...(account===undefined?{}:{account})});assert.equal(result.ok,true);return result.data;};
  return {send,ingest,bind,get,tabs,sent,handlers,db,queries,created,broadcasts};
}
const row=(id,jobId,extra={})=>({id,jobId,name:'模拟联系人',companyName:'模拟公司',jobTitle:`职位 ${jobId}`,...extra});
const snapshot=(account,rows)=>({type:'SNAPSHOT',account,rows});

test('拒绝沟通可手动保存，采集后保留，恢复自动时采用最新证据',async()=>{
  const h=await harness(),jobId=A+':job:j1';
  await h.ingest(snapshot(A,[row('c1','j1',{lastText:'您好',lastIsSelf:false,lastMessageAt:10})]));
  assert.equal((await h.get(A)).jobs[0].status,'awaiting_self');
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,status:'communication_rejected',note:'手动记录'})).ok,true);
  await h.ingest(snapshot(A,[row('c1','j1',{lastText:'再联系',lastIsSelf:true,lastMessageAt:20})]));
  const job=(await h.get(A)).jobs[0];
  assert.equal(job.status,'communication_rejected');assert.equal(job.manualStatus,'communication_rejected');assert.equal(job.manual,true);assert.equal(job.autoStatus,'awaiting_boss');assert.equal(job.note,'手动记录');
  const widget=await h.send({type:'WIDGET_GET',account:A,jobId:'j1'},{url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}});
  assert.equal(widget.ok,true,widget.error);
  assert.equal(widget.data.jobs[0].status,'communication_rejected');assert.equal(widget.data.jobs[0].manual,true);
  assert.equal((await h.send({type:'SET_STATUS',account:A,jobId,status:'auto'})).ok,true);
  const automatic=(await h.get(A)).jobs[0];assert.equal(automatic.status,'awaiting_boss');assert.equal(automatic.manual,false);assert.equal(automatic.note,'手动记录');
});

test('删除指定JD保留其他职位和对话，后续采集与收藏不会将它重新收录',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}},jobId=A+':job:j1';
  await h.ingest(snapshot(A,[row('c1','j1'),row('c2','j2')]));
  await h.ingest(snapshot(B,[row('c3','j1')]));
  await h.send({type:'SAVE_JOB',account:A,jobId,note:'待删除备注',status:'interviewing'});
  const before=await h.get(A),target=before.jobs.find(job=>job.id===jobId);
  assert.equal((await h.send({type:'DELETE_JOB',account:A,jobId,expectedUpdatedAt:target.updatedAt})).ok,true);
  let after=await h.get(A);assert.deepEqual(after.jobs.map(job=>job.id),[A+':job:j2']);assert.equal(after.conversations.length,before.conversations.length);
  assert.ok(after.events.every(event=>event.jobId!==jobId));
  assert.equal(after.conversations.find(conversation=>conversation.id.endsWith('c1')).jobTitle,'');
  const exported=await h.send({type:'EXPORT',account:A});assert.ok(!exported.data.jobs.some(job=>job.id===jobId));assert.ok(!JSON.stringify(exported.data).includes('待删除备注'));
  await h.ingest(snapshot(A,[row('c1','j1'),row('c2','j2')]));
  await h.ingest({type:'FAVORITES',account:A,rows:[{jobId:'j1',title:'职位 j1',companyName:'模拟公司',favorite:true}]});
  await h.ingest({type:'PAGE_CONTEXT',account:A,jobId:'j1',title:'职位 j1',companyName:'模拟公司',favorite:true});
  after=await h.get(A);assert.deepEqual(after.jobs.map(job=>job.id),[A+':job:j2']);assert.equal(after.conversations.length,2);
  const widget=await h.send({type:'WIDGET_GET',account:A,jobId:'j1',companyName:'模拟公司',title:'职位 j1'},site);
  assert.ok(widget.data.jobs.every(job=>job.id!==jobId));
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,note:'不能恢复'})).ok,false);
  assert.equal((await h.send({type:'SET_STATUS',account:A,jobId,status:'passed'})).ok,false);
  assert.equal((await h.get(B)).jobs.length,1);
});

test('删除遵守账号及来源隔离，并拒绝过期版本',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}},jobId=A+':job:j1';
  await h.ingest(snapshot(A,[row('c1','j1')]));await h.ingest(snapshot(B,[row('c2','j1')]));
  const before=await h.get(A),job=before.jobs[0];
  assert.equal((await h.send({type:'DELETE_JOB',account:B,jobId})).ok,false);
  assert.equal((await h.send({type:'DELETE_JOB',account:A,jobId},{...site,tab:{id:999}})).ok,false);
  assert.equal((await h.send({type:'DELETE_JOB',account:A,jobId,expectedUpdatedAt:job.updatedAt+1})).ok,false);
  assert.deepEqual(await h.get(A),before);assert.equal((await h.get(B)).jobs.length,1);
});

test('绑定当前账号的站点浮窗可删除卡片，其他标签和账号不可操作',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/jobs',tab:{id:8}},jobId=A+':job:j1';
  await h.ingest(snapshot(A,[row('c1','j1')]));await h.bind(A,site);
  const found=await h.send({type:'WIDGET_GET',account:A,jobId:'j1'},site);assert.equal(found.ok,true);
  assert.equal((await h.send({type:'WIDGET_GET',account:A,jobId:'j1'},{...site,tab:{id:9}})).ok,false);
  assert.equal((await h.send({type:'DELETE_JOB',account:B,jobId},site)).ok,false);
  assert.equal((await h.send({type:'DELETE_JOB',account:A,jobId,expectedUpdatedAt:found.data.jobs[0].updatedAt},site)).ok,true);
  assert.equal((await h.get(A)).jobs.length,0);assert.equal((await h.get(A)).conversations.length,1);
});

test('删除公司保留聊天和其他公司的职位，后续观察不会重新收录',async()=>{
  const h=await harness();
  const companyId=A+':company:模拟公司';
  const sameCompany=[row('c1','j1'),row('c2','j2')];
  const otherJob=row('c3','j3',{companyName:'其他公司'});
  await h.ingest(snapshot(A,[...sameCompany,otherJob]));
  const site={url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}};
  const mock={url:'http://127.0.0.1:4173/web/geek/chat',tab:{id:2}};
  await h.ingest(snapshot(B,sameCompany),mock);
  await h.ingest({type:'CONVERSATION',account:A,row:sameCompany[0],messages:[{id:'chat1',time:10,text:'之前的聊天',direction:'in'}]});
  assert.equal((await h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId,note:'公司备注'})).ok,true);
  const deletion={type:'DELETE_COMPANY',account:A,companyId,expectedNote:'公司备注'};
  assert.equal((await h.send(deletion,mock)).ok,false);
  assert.equal((await h.send({...deletion,expectedNote:''},site)).ok,false);
  assert.equal((await h.send(deletion,site)).ok,true);
  await h.ingest(snapshot(A,[...sameCompany,row('c4','new-job')]));
  await h.ingest({type:'FAVORITES',account:A,rows:[{jobId:'new-favorite',title:'新收藏',companyName:'模拟公司',favorite:true}]});
  const result=(await h.send({type:'EXPORT',account:A})).data;
  assert.deepEqual(result.jobs.map(job=>job.id),[A+':job:j3']);
  assert.deepEqual(result.companies.map(company=>company.name),['其他公司']);
  assert.equal(result.conversations.length,4);
  assert.equal(result.messages[0].text,'之前的聊天');
  assert.equal((await h.get(B)).jobs.length,2);
  const widget=await h.send({type:'WIDGET_GET',account:A,jobId:'new-job',companyName:'模拟公司',title:'新职位'},site);
  assert.equal(widget.data.companyDeleted,true);
  assert.deepEqual(widget.data.jobs,[]);
});

test('删除事务失败时不会丢失JD、备注、对话或事件',async()=>{
  const h=await harness(),jobId=A+':job:j1';await h.ingest(snapshot(A,[row('c1','j1')]));
  await h.send({type:'SAVE_JOB',account:A,jobId,note:'必须保留',status:'interviewing'});
  const before=await h.get(A),put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){const request=put.apply(this,args);if(this.name==='jobs'&&args[0]?.deleted)request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;};
  try{assert.equal((await h.send({type:'DELETE_JOB',account:A,jobId})).ok,false);}finally{IDBObjectStore.prototype.put=put;}
  assert.deepEqual(await h.get(A),before);
});

test('同一联系人涉及多个JD时，删除一条后更新另一条不会重建已删除信息',async()=>{
  const h=await harness(),jobId=A+':job:j1';
  await h.ingest(snapshot(A,[row('c1','j1')]));
  await h.ingest(snapshot(A,[row('c1','j2')]));
  await h.send({type:'SAVE_JOB',account:A,jobId,note:'已删除的备注',status:'interviewing'});
  assert.equal((await h.send({type:'DELETE_JOB',account:A,jobId})).ok,true);
  await h.ingest(snapshot(A,[row('c1','j2')]));
  const data=await h.get(A);assert.deepEqual(data.jobs.map(job=>job.id),[A+':job:j2']);assert.equal(data.conversations.length,1);assert.ok(data.events.every(event=>event.jobId!==jobId));
  let tombstone;await updateStored(h,'jobs',job=>{if(job.id===jobId)tombstone=structuredClone(job);return job;});
  assert.equal(tombstone.deleted,true);assert.equal(tombstone.note,undefined);assert.equal(tombstone.status,undefined);assert.equal(tombstone.autoContributions,undefined);
});

test('仅收藏的JD取消后从浮窗和总视图消失，重新收藏或沟通时恢复原备注',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/recommend?tab=4&sub=1',tab:{id:8}};
  const favorite={jobId:'only-favorite',title:'收藏职位',companyName:'收藏公司',favorite:true},jobId=A+':job:only-favorite';
  await h.ingest({type:'FAVORITES',account:A,rows:[favorite]},site);
  await h.send({type:'SAVE_JOB',account:A,jobId,note:'原备注',status:'interviewing'});
  await h.ingest({type:'FAVORITES',account:A,rows:[{jobId:'only-favorite',favorite:false}]},site);
  const hidden=await h.get(A);assert.equal(hidden.jobs.length,0);assert.equal(hidden.companies.length,0);assert.equal(hidden.conversations.length,0);
  for(const preview of [true,false]){
    const widget=await h.send({type:'WIDGET_GET',account:A,jobId:'only-favorite',companyName:'收藏公司',title:'收藏职位',preview},site);
    assert.equal(widget.data.jobs.length,0);assert.equal(widget.data.currentJobId,null);
  }
  const exported=await h.send({type:'EXPORT',account:A});assert.equal(exported.data.jobs[0].note,'原备注');assert.equal(exported.data.jobs[0].favorite,false);
  assert.equal(h.broadcasts.filter(message=>message.type==='FAVORITES_CHANGED'&&message.account===A).length,2);
  await h.ingest({type:'FAVORITES',account:A,rows:[favorite]},site);
  let restored=(await h.get(A)).jobs[0];assert.equal(restored.note,'原备注');assert.equal(restored.status,'interviewing');assert.equal(restored.favorite,true);
  await h.ingest({type:'FAVORITES',account:A,rows:[{jobId:'only-favorite',favorite:false}]},site);
  await h.ingest(snapshot(A,[row('c1','only-favorite',{companyName:'收藏公司'})]));
  restored=(await h.get(A)).jobs[0];assert.equal(restored.note,'原备注');assert.equal(restored.status,'interviewing');assert.equal(restored.favorite,false);assert.equal(restored.conversationIds.length,1);
});

test('取消收藏后仍有关联对话的JD继续展示，支持从对话反向关联恢复',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/jobs',tab:{id:4}};
  await h.ingest(snapshot(A,[row('c1','j1')]));await h.bind(A,site);
  await h.ingest({type:'FAVORITES',account:A,rows:[{jobId:'j1',title:'职位 j1',companyName:'模拟公司',favorite:true}]},site);
  await h.ingest({type:'FAVORITES',account:A,rows:[{jobId:'j1',favorite:false}]},site);
  await updateStored(h,'jobs',job=>({...job,conversationId:null,conversationIds:[]}));
  const data=await h.get(A);assert.equal(data.jobs.length,1);assert.equal(data.jobs[0].favorite,false);
  const widget=await h.send({type:'WIDGET_GET',account:A,jobId:'j1',companyName:'模拟公司',preview:true},site);
  assert.equal(widget.data.jobs.length,1);assert.equal(widget.data.jobs[0].current,true);
});

test('普通未收藏浏览不会隐藏从未收藏的手动JD',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/jobs',tab:{id:4}},jobId=A+':job:manual';
  await h.bind(A,site);
  await h.send({type:'SAVE_JOB',account:A,jobId,note:'手动记录',context:{companyId:A+':company:模拟公司',companyName:'模拟公司',title:'手动职位'}});
  await h.ingest({type:'PAGE_CONTEXT',account:A,jobId:'manual',companyName:'模拟公司',title:'手动职位',favorite:false},site);
  const data=await h.get(A);assert.equal(data.jobs.length,1);assert.equal(data.jobs[0].note,'手动记录');assert.equal(data.jobs[0].favorite,undefined);
});

test('收藏批次创建公司和JD，重复读取不增加记录，也不虚构对话',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/recommend?tab=4&sub=1',tab:{id:8}};
  const rows=[{jobId:'fav-1',companyName:'收藏公司',title:'前端',favorite:true},{jobId:'fav-2',companyName:'收藏公司',title:'后端',favorite:true}];
  assert.equal((await h.ingest({type:'FAVORITES',account:A,rows},site)).ok,true);
  const data=await h.get(A);assert.equal(data.jobs.length,2);assert.equal(data.companies.length,1);assert.equal(data.conversations.length,0);assert.equal(data.events.length,0);
  assert.ok(data.jobs.every(job=>job.favorite&&job.status==='unknown'&&job.conversationIds.length===0));
  assert.equal((await h.ingest({type:'FAVORITES',account:A,rows},site)).ok,true);
  assert.deepEqual(await h.get(A),data);
  const widget=await h.send({type:'WIDGET_GET',account:A,companyName:'收藏公司',jobId:'fav-1',preview:true},site);
  assert.equal(widget.data.jobs[0].favorite,true);assert.match(widget.data.jobs[0].url,/^https:\/\/www\.zhipin\.com\/job_detail\/fav-1\.html$/);
});

test('收藏合并已有JD时保留人工状态和备注，后续聊天采集也保留收藏标识',async()=>{
  const h=await harness(),jobId=A+':job:j1';
  await h.ingest(snapshot(A,[row('c1','j1')]));
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,status:'interviewing',note:'保留备注'})).ok,true);
  const favorite={jobId:'j1',companyName:'网页公司简称',title:'页面标题',favorite:true};
  assert.equal((await h.ingest({type:'FAVORITES',account:A,rows:[favorite]})).ok,true);
  await h.ingest(snapshot(A,[row('c1','j1')]));
  const data=await h.get(A),job=data.jobs[0];assert.equal(data.jobs.length,1);assert.equal(job.favorite,true);assert.equal(job.manualStatus,'interviewing');assert.equal(job.note,'保留备注');assert.equal(data.companies.length,1);
  assert.equal((await h.ingest({type:'FAVORITES',account:A,rows:[{jobId:'j1',favorite:false}]})).ok,true);
  const after=(await h.get(A)).jobs[0];assert.equal(after.favorite,false);assert.equal(after.note,'保留备注');assert.equal(after.status,'interviewing');
});

test('部分收藏列表不清除未加载收藏，取消未知收藏不创建JD，普通浏览不入库',async()=>{
  const h=await harness();
  await h.ingest({type:'FAVORITES',account:A,rows:[{jobId:'f1',title:'一',companyName:'公司',favorite:true},{jobId:'f2',title:'二',companyName:'公司',favorite:true}]});
  await h.ingest({type:'FAVORITES',account:A,rows:[{jobId:'f1',title:'一',companyName:'公司',favorite:true}]});
  await h.ingest({type:'PAGE_CONTEXT',account:A,jobId:'new',companyName:'新公司',title:'新职位',favorite:false});
  const data=await h.get(A);assert.equal(data.jobs.length,2);assert.equal(data.companies.length,1);assert.ok(data.jobs.every(job=>job.favorite));
  await h.ingest({type:'PAGE_CONTEXT',account:A,jobId:'new',companyName:'新公司',title:'新职位',favorite:true});
  const after=await h.get(A);assert.equal(after.jobs.length,3);assert.equal(after.conversations.length,0);
});

test('收藏字段整批验证，来源和账号保持隔离',async()=>{
  const h=await harness(),favorite={jobId:'saved',title:'收藏职位',companyName:'收藏公司',favorite:true};
  const invalid=await h.ingest({type:'FAVORITES',account:A,rows:[favorite,{...favorite,jobId:'../invalid'}]});assert.equal(invalid.ok,false);
  assert.equal((await h.send({type:'DB_GET',account:A})).ok,false);
  await h.ingest({type:'FAVORITES',account:A,rows:[favorite]});
  const mock={url:'http://127.0.0.1:4173/web/geek/recommend',tab:{id:4}};
  assert.equal((await h.ingest({type:'FAVORITES',account:A,rows:[favorite]},mock)).ok,false);
  assert.equal((await h.ingest({type:'FAVORITES',account:B,rows:[favorite]},mock)).ok,true);
  assert.equal((await h.get(B)).jobs[0].url,'http://127.0.0.1:4173/job_detail/saved.html');
  assert.equal((await h.get(A)).jobs.length,1);
});
// Mutate only this harness's in-memory database to simulate pre-contribution records.
async function updateStored(h,storeName,transform){
  const db=await new Promise((resolve,reject)=>{const req=h.db.open('boss-local-helper',2);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  try{
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(storeName,'readwrite'),store=tx.objectStore(storeName),req=store.getAll();
      req.onsuccess=()=>{for(const item of req.result){const next=transform(item);if(!next||next.id!==item.id)store.delete(item.id);if(next)store.put(next);}};
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
  }finally{db.close();}
}

test('各 API 迁移离线面试存量并清理旧设置，保留备注和并发比较',async()=>{
  for(const trigger of ['DB_GET','WIDGET_GET','EXPORT','SAVE_JOB','SET_STATUS']){
    const h=await harness(),site={url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}},jobId=`${A}:job:j1`,offlineId=`${A}:job:j2`;
    await h.ingest(snapshot(A,[row('c1','j1'),row('c2','j2')]),site);
    await updateStored(h,'jobs',j=>({...j,manualStatus:'interview_2',status:'interview_2',autoStatus:'interview_12',manual:true,note:'旧备注',noteConflicts:[{sourceId:'old',text:'冲突'}]}));
    await updateStored(h,'conversations',c=>c.id.endsWith('c2')?null:c);
    await updateStored(h,'meta',m=>m.id===`${A}:sourceGroup`?{...m,extra:'keep'}:m);
    const db=await new Promise((resolve,reject)=>{const req=h.db.open('boss-local-helper',2);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
    await new Promise((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put({id:`${A}:settings`,value:{interviewRounds:7,other:'保留'}});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
    const messages={DB_GET:{type:'DB_GET',account:A},WIDGET_GET:{type:'WIDGET_GET',account:A,jobId:'j1'},EXPORT:{type:'EXPORT',account:A},SAVE_JOB:{type:'SAVE_JOB',account:A,jobId,note:'新备注',expectedManualStatus:'interviewing'},SET_STATUS:{type:'SET_STATUS',account:A,jobId,status:'passed'}};
    const result=await h.send(messages[trigger],trigger==='WIDGET_GET'?site:undefined);
    assert.equal(result.ok,true,`${trigger}: ${result.error}`);
    // Inspect storage directly before a second API can mask a missing migration.
    let storedJobs,storedSettings;
    await updateStored(h,'jobs',j=>{(storedJobs??=[]).push(j);return j;});
    await updateStored(h,'meta',m=>{if(m.id===`${A}:settings`)storedSettings=m.value;return m;});
    const offline=storedJobs.find(j=>j.id===offlineId);
    assert.equal(offline.manualStatus,'interviewing',trigger);assert.equal(offline.status,'interviewing',trigger);assert.equal(offline.autoStatus,'interviewing',trigger);
    assert.equal(offline.note,'旧备注');assert.deepEqual(offline.noteConflicts,[{sourceId:'old',text:'冲突'}]);assert.equal(offline.manual,true);
    assert.deepEqual(storedSettings,{other:'保留'});
    if(['DB_GET','WIDGET_GET','EXPORT'].includes(trigger))assert.deepEqual(result.data.settings,{});
    const stale=await h.send({type:'SAVE_JOB',account:A,jobId:offlineId,note:'不能保存',expectedManualStatus:'interview_2'});
    assert.equal(stale.ok,false);assert.match(stale.error,/预期人工状态/);
    const conflict=await h.send({type:'SAVE_JOB',account:A,jobId:offlineId,note:'不能保存',expectedManualStatus:null});
    assert.equal(conflict.ok,false);assert.match(conflict.error,/状态冲突/);
    assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId:offlineId,note:'已保存',expectedManualStatus:'interviewing'})).ok,true);
    for(const type of ['SAVE_JOB','SET_STATUS'])assert.equal((await h.send({type,account:A,jobId:offlineId,status:'interview_1'})).ok,false);
    assert.equal((await h.send({type:'SET_SETTINGS',account:A,interviewRounds:3})).ok,false);
  }
});

test('旧记录仅有人工标记和面试状态时，采集前恢复人工状态',async()=>{
  const h=await harness();await h.ingest(snapshot(A,[row('c1','j1')]));
  await updateStored(h,'jobs',job=>({...job,manualStatus:null,manual:true,status:'interview_3',autoStatus:'unknown'}));
  await h.ingest(snapshot(A,[row('c1','j1',{lastIsSelf:false,lastText:'你好'})]));
  const job=(await h.get(A)).jobs[0];
  assert.equal(job.manualStatus,'interviewing');assert.equal(job.status,'interviewing');assert.equal(job.autoStatus,'awaiting_self');
});

test('空数据库 DB_GET 返回空集合',async()=>{
  const h=await harness(), data=await h.get();
  assert.equal(data.account,null);
  assert.deepEqual(data.accounts,[]);
  for(const name of ['companies','jobs','conversations','events']) assert.deepEqual(data[name],[]);
});

test('单一扩展接受本地 mock 来源并生成 mock 职位链接',async()=>{
  const h=await harness(),mock={url:'http://127.0.0.1:4173/web/geek/chat',tab:{id:5}};
  assert.equal((await h.ingest(snapshot(A,[row('c1','j1')]),mock)).ok,true);
  const job=(await h.get(A)).jobs[0];
  assert.equal(job.url,'http://127.0.0.1:4173/job_detail/j1.html');
  await updateStored(h,'jobs',item=>({...item,autoSchemaVersion:0}));
  assert.equal((await h.get(A)).jobs[0].url,'http://127.0.0.1:4173/job_detail/j1.html');
  await h.ingest(snapshot(B,[row('real-contact','real-job')]));
  assert.equal((await h.get(A)).jobs[0].url,'http://127.0.0.1:4173/job_detail/j1.html');
  assert.equal((await h.get(B)).jobs[0].url,'https://www.zhipin.com/job_detail/real-job.html');
  assert.equal((await h.ingest(snapshot(A,[row('c2','j2')]),{...mock,url:'https://example.com/web/geek/chat'})).ok,false);
});

test('浮窗打开总视图时使用当前页面账号及窗口，不改变默认账号',async()=>{
  const h=await harness(),mock={url:'http://127.0.0.1:4173/web/geek/chat',tab:{id:5,windowId:7}};
  await h.ingest(snapshot(B,[row('real','real-job')]));
  await h.ingest(snapshot(A,[row('mock','mock-job')]),mock);
  assert.equal((await h.get()).account,B);
  assert.equal((await h.send({type:'OPEN_DASHBOARD'},mock)).ok,true);
  assert.equal(h.created.at(-1).url,'chrome-extension://test/dist/dashboard.html?account='+A);
  assert.equal(h.created.at(-1).windowId,7);
  assert.equal((await h.send({type:'OPEN_DASHBOARD',view:'board'},mock)).ok,true);
  assert.deepEqual(h.created.at(-1),{url:'chrome-extension://test/dist/dashboard.html?account='+A+'#board',windowId:7});
  await h.handlers.action(mock.tab);
  assert.deepEqual(h.created.at(-1),{url:'chrome-extension://test/dist/dashboard.html?account='+A+'#board',windowId:7});
  await h.handlers.action({id:9,windowId:7});
  assert.deepEqual(h.created.at(-1),{url:'chrome-extension://test/dist/dashboard.html#board',windowId:7});
  assert.equal((await h.get()).account,B);
  const unknown={url:'http://127.0.0.1:4173/web/geek/chat',tab:{id:6}};
  const result=await h.send({type:'OPEN_DASHBOARD'},unknown);
  assert.equal(result.ok,false);assert.match(result.error,/账号尚未识别/);
  assert.equal(h.created.length,4);
  assert.equal((await h.send({type:'OPEN_DASHBOARD',account:A},{...unknown,tab:{id:6,windowId:8}})).ok,false);
  await h.bind(A,unknown);
  assert.equal((await h.send({type:'OPEN_DASHBOARD',account:A},{...unknown,tab:{id:6,windowId:8}})).ok,true);
  assert.equal(h.created.at(-1).windowId,8);assert.match(h.created.at(-1).url,new RegExp(A));
});

test('同步同时查找真实与本地 mock 聊天页',async()=>{
  const h=await harness({onSend:(id,message)=>message.type==='ACCOUNT_INFO'?{account:A}:{ok:true}});
  await h.ingest(snapshot(A,[]),{url:'http://127.0.0.1:4173/web/geek/chat',tab:{id:5}});
  h.tabs.push({id:9,url:'http://127.0.0.1:4173/web/geek/chat',active:true});
  const result=await h.send({type:'SYNC',account:A});
  assert.equal(result.ok,true,result.error);
  assert.deepEqual(h.queries[0].url,['https://www.zhipin.com/web/geek/chat*','http://127.0.0.1:4173/web/geek/chat*','http://localhost:4173/web/geek/chat*']);
  assert.equal(h.sent.at(-1).id,9);
});

test('网页快照关联一家公司和两个职位，账号切换后数据隔离',async()=>{
  const h=await harness();
  assert.equal((await h.ingest(snapshot(A,[row('c1','j1'),row('c2','j2')]))).count,2);
  let data=await h.get();
  assert.equal(data.account,A);assert.equal(data.companies.length,1);assert.equal(data.jobs.length,2);
  assert.ok(data.jobs.every(j=>j.companyId===data.companies[0].id));
  assert.deepEqual(data.conversations.map(c=>c.jobIds[0]).sort(),data.jobs.map(j=>j.id).sort());
  assert.equal((await h.ingest(snapshot(B,[row('c3','j3')]),{url:'https://www.zhipin.com/web/geek/chat',tab:{id:2}})).ok,true);
  data=await h.get();assert.equal(data.account,A);assert.deepEqual(data.accounts,[A,B]);assert.equal(data.jobs.length,2);
  assert.equal((await h.send({type:'SELECT_ACCOUNT',account:B})).ok,true);
  data=await h.get();assert.equal(data.account,B);assert.equal(data.jobs.length,1);assert.ok(data.jobs.every(j=>j.account===B));
  assert.equal((await h.send({type:'SELECT_ACCOUNT',account:A})).ok,true);
  assert.equal((await h.get()).jobs.length,2);
});

test('WIDGET_GET 按已知职位返回同公司职位并隔离账号',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/job_detail/example.html',tab:{id:3}};
  await h.ingest(snapshot(A,[row('c1','j1'),row('c2','j2'),row('c3','j3',{companyName:'其他公司'})]));
  await h.ingest(snapshot(B,[row('c4','j1'),row('c5','b2')]));
  await h.send({type:'SET_STATUS',account:A,jobId:`${A}:job:j2`,status:'interviewing'});
  await h.bind(A,site);
  const result=await h.send({type:'WIDGET_GET',account:A,jobId:'j2',companyName:'错误公司',title:'页面标题'},site);
  result.data.jobs=result.data.jobs.map(({url,favorite,updatedAt,...job})=>{assert.equal(favorite,false);assert.equal(typeof updatedAt,'number');assert.equal(url,'https://www.zhipin.com/job_detail/'+job.id.split(':job:')[1]+'.html');return job;});
  assert.deepEqual(result,{ok:true,data:{companyId:`${A}:company:模拟公司`,companyName:'模拟公司',companyNote:'',companyPersisted:true,settings:{},jobs:[
    {id:`${A}:job:j1`,title:'职位 j1',status:'unknown',label:'未知',manual:false,current:false,note:'',persisted:true,firstConversationAt:0},
    {id:`${A}:job:j2`,title:'职位 j2',status:'interviewing',label:'未知',manual:true,current:true,note:'',persisted:true,firstConversationAt:0}
  ],currentJobId:`${A}:job:j2`}});
  const otherSite={...site,tab:{id:4}};await h.bind(B,otherSite);
  const other=await h.send({type:'WIDGET_GET',account:B,jobId:'j1'},otherSite);
  assert.deepEqual(other.data.jobs.map(j=>j.id),[`${B}:job:b2`,`${B}:job:j1`]);
  assert.equal(other.data.currentJobId,`${B}:job:j1`);
  assert.equal((await h.send({type:'WIDGET_GET',jobId:'j1'},site)).ok,false);
  assert.equal((await h.send({type:'WIDGET_GET',account:'c'.repeat(24)},site)).ok,false);
  assert.equal((await h.send({type:'WIDGET_GET',account:A,jobId:'x'.repeat(201)},site)).ok,false);
  assert.equal((await h.send({type:'WIDGET_GET',account:A,companyName:'x'.repeat(181)},site)).ok,false);
  assert.equal((await h.send({type:'WIDGET_GET',account:A,title:'x'.repeat(6001)},site)).ok,false);
  assert.equal((await h.send({type:'WIDGET_GET',account:A})).ok,false);
});

test('WIDGET_GET 未知职位为临时行，标题匹配仅在唯一时高亮',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/job',tab:{id:3}};
  await h.ingest(snapshot(A,[row('c1','j1',{jobTitle:'相同'}),row('c2','j2',{jobTitle:'相同'}),row('c3','j3',{jobTitle:'唯一'})]));
  await h.bind(A,site);
  const before=await h.get(A);
  const unknown=await h.send({type:'WIDGET_GET',account:A,jobId:'new',companyName:'  模拟公司  ',title:'新职位'},site);
  assert.equal(unknown.data.companyName,'模拟公司');assert.equal(unknown.data.jobs.length,4);
  assert.deepEqual(unknown.data.jobs.at(-1),{id:`${A}:job:new`,title:'新职位',status:'unknown',manual:false,current:true,note:'',persisted:false,firstConversationAt:0});
  assert.equal(unknown.data.currentJobId,`${A}:job:new`);
  assert.deepEqual(await h.get(A),before);
  const unique=await h.send({type:'WIDGET_GET',account:A,companyName:'模拟公司',title:'唯一'},site);
  assert.equal(unique.data.currentJobId,`${A}:job:j3`);assert.equal(unique.data.jobs.filter(j=>j.current).length,1);
  const ambiguous=await h.send({type:'WIDGET_GET',account:A,companyName:'模拟公司',title:'相同'},site);
  assert.equal(ambiguous.data.currentJobId,null);assert.deepEqual(ambiguous.data.jobs.at(-1),{id:null,title:'相同',status:'unknown',manual:false,current:true,note:'',persisted:false,firstConversationAt:0});
  const missing=await h.send({type:'WIDGET_GET',account:A,companyName:'新公司',jobId:'new',title:'新职位'},site);
  assert.equal(missing.data.companyName,'新公司');assert.equal(missing.data.jobs.length,1);
});

test('职位详情预览提供可编辑的临时 JD，显式保存才创建本地记录',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/jobs',tab:{id:3}};
  await h.ingest(snapshot(A,[row('c1','j1',{jobTitle:'前端'}),row('c2','j2',{jobTitle:'后端'})]));
  await h.bind(A,site);
  const before=await h.get(A);
  for(const [jobId,companyName,title] of [['j1','模拟公司','前端'],['new','模拟公司','前端'],['new-company-job','新公司','新职位']]){
    const context={type:'PAGE_CONTEXT',account:A,jobId,companyName,title};
    assert.equal((await h.send({type:'INGEST',data:context},site)).ok,true);
    const result=await h.send({type:'WIDGET_GET',account:A,jobId,companyName,title,preview:true},site);
    assert.equal(result.ok,true,result.error);
    assert.equal(result.data.jobs.length,companyName==='新公司'?1:jobId==='j1'?2:3);
    assert.equal(result.data.jobs.filter(job=>job.current).length,1);
    assert.equal(result.data.currentJobId,A+':job:'+jobId);
    assert.equal(result.data.jobs.find(job=>job.current).persisted,jobId==='j1');
  }
  assert.deepEqual(await h.get(A),before);
  const details={url:'https://www.zhipin.com/job_detail/new-company-job.html',tab:{id:4}};
  await h.bind(A,details);
  const jobId='new-company-job',companyName='新公司',title='新职位';
  const preview=await h.send({type:'WIDGET_GET',account:A,jobId,companyName,title,preview:true},details);
  const companyId=preview.data.companyId;
  assert.equal((await h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId,companyName,note:'详情公司备注',expectedNote:''},details)).ok,true);
  assert.equal((await h.get(A)).jobs.length,before.jobs.length);
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId:A+':job:'+jobId,note:'详情 JD 备注',expectedNote:'',status:'passed',expectedManualStatus:null,
    context:{companyId,companyName,title,preview:true}},details)).ok,true);
  const saved=await h.get(A);
  const added=saved.jobs.find(job=>job.id===A+':job:'+jobId);
  assert.equal(added.note,'详情 JD 备注');
  assert.equal(added.manualStatus,'passed');
  assert.equal(saved.companies.find(company=>company.id===companyId).note,'详情公司备注');
  assert.equal(saved.conversations.length,before.conversations.length);
});

test('独立职位详情补全同 ID 的已有占位标题，保留状态和备注',async()=>{
  const h=await harness();
  const rows=[row('closed-contact','closed',{jobTitle:''}),row('active-contact','active',{jobTitle:''})];
  await h.ingest(snapshot(A,rows));
  await h.ingest(snapshot(B,rows));
  const closedId=A+':job:closed';
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId:closedId,status:'interviewing',note:'保留备注'})).ok,true);
  const detailPage=jobId=>({url:'https://www.zhipin.com/job_detail/'+jobId+'.html?source=test',tab:{id:4}});
  const observe=(jobId,title,sender,extra={})=>h.ingest({type:'PAGE_CONTEXT',account:A,jobId,companyName:'模拟公司',title,...extra},sender);
  assert.equal((await observe('closed','错配标题',detailPage('active'))).ok,true);
  assert.equal((await h.get(A)).jobs.find(job=>job.id===closedId).title,'待识别 JD');
  assert.equal((await observe('closed','前端工程师',detailPage('closed'))).summary.jobTitle,'前端工程师');
  assert.equal((await observe('active','后端工程师',detailPage('active'),{favorite:false})).summary.jobTitle,'后端工程师');
  assert.equal((await observe('new','未保存的新职位',detailPage('new'))).ok,true);
  assert.equal((await observe('closed','另一个标题',detailPage('closed'))).summary.jobTitle,'前端工程师');
  await h.ingest(snapshot(A,[row('closed-contact','closed',{jobTitle:'列表里的旧标题'}),rows[1]]));
  const widget=await h.send({type:'WIDGET_GET',account:A,jobId:'active',preview:true},detailPage('active'));
  assert.equal(widget.ok,true,widget.error);
  assert.deepEqual(widget.data.jobs.map(job=>[job.title,job.current]),[['后端工程师',true],['前端工程师',false]]);
  const closed=widget.data.jobs.find(job=>job.id===closedId);
  assert.equal(closed.status,'interviewing');
  assert.equal(closed.note,'保留备注');
  assert.ok((await h.get(B)).jobs.every(job=>job.title==='待识别 JD'));
});

test('现有已采集面试卡片回填自动状态，保留手动状态和备注', async () => {
  const h = await harness();
  const jobId = A + ':job:interview';
  await h.ingest({type:'CONVERSATION',account:A,row:row('candidate','interview'),messages:[
    {id:'1',time:10,text:'您好，想了解这个岗位',type:1,bodyType:1,direction:'out'},
    {id:'2',time:20,text:'模拟招聘方邀请您线上面试',type:3,bodyType:14,templateId:1,direction:'in'},
    {id:'3',time:30,text:'接受了面试邀请',type:3,bodyType:14,templateId:1,messageType:'interview',isSystem:false,direction:'out'},
  ]});
  await h.send({type:'SAVE_JOB',account:A,jobId,status:'passed',note:'保留备注'});
  await updateStored(h,'jobs',job => ({...job,autoStatus:'awaiting_boss',autoSchemaVersion:5}));
  const site = {url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}};
  const widget = async () => (await h.send({type:'WIDGET_GET',account:A,jobId:'interview'},site)).data.jobs[0];
  const manual = await widget();
  assert.equal(manual.status,'passed');
  assert.equal(manual.note,'保留备注');
  assert.deepEqual(manual.latestMessage,{text:'您好，想了解这个岗位',direction:'out'});
  await h.send({type:'SAVE_JOB',account:A,jobId,status:'auto'});
  const automatic = await widget();
  assert.equal(automatic.status,'interviewing');
  assert.equal(automatic.manual,false);
});

test('看板使用产生状态的消息或人工操作时间，重复采集和修改备注不会重置', async () => {
  const h = await harness();
  const jobId = A + ':job:interview';
  const inviteAt = Date.UTC(2026, 9, 18, 10, 30);
  const acceptedAt = inviteAt + 60000;
  const invite = {id:'1',time:inviteAt,text:'模拟招聘方邀请您线上面试',type:3,bodyType:14,templateId:1,direction:'in'};
  const accepted = {id:'2',time:acceptedAt,text:'接受了面试邀请',type:3,bodyType:14,templateId:1,direction:'out'};
  const collect = messages => h.ingest({type:'CONVERSATION',account:A,row:row('candidate','interview'),messages});
  const current = async () => (await h.get(A)).jobs.find(job => job.id === jobId);
  const save = patch => h.send({type:'SAVE_JOB',account:A,jobId,...patch});

  await collect([invite]);
  assert.equal((await current()).statusAt, inviteAt);
  assert.equal((await save({status:'interviewing'})).ok, true);
  const manualAt = (await h.get(A)).events.find(event => event.source === 'manual').time;
  assert.equal((await current()).statusAt, manualAt);
  await collect([invite, accepted]);
  assert.equal((await save({note:'跟进面试'})).ok, true);
  assert.equal((await current()).statusAt, manualAt);
  assert.equal((await save({status:'auto'})).ok, true);
  await collect([invite, accepted]);
  assert.equal((await current()).statusAt, acceptedAt);
  const restoredAt = (await h.get(A)).events.find(event => event.evidence === '恢复自动状态').time;
  assert.equal((await current()).statusActivityAt, restoredAt);

  await h.ingest(snapshot(A,[row('unknown','undated')]));
  const undated = (await h.get(A)).jobs.find(job => job.id.endsWith(':undated'));
  assert.ok(undated.updatedAt > 0);
  assert.equal(undated.statusAt, undefined);
});

test('浮窗为每个职位选择最近的人工消息，并区分发送方', async () => {
  const h = await harness();
  const site = {url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}};
  const collect = (contact, job, messages) => h.ingest({type:'CONVERSATION',account:A,row:row(contact,job),messages});
  const previews = async () => {
    const response = await h.send({type:'WIDGET_GET',account:A,jobId:'j1'}, site);
    assert.equal(response.ok, true, response.error);
    return Object.fromEntries(response.data.jobs.map(job => [job.title, job.latestMessage]));
  };
  await collect('shared', 'j1', [
    {id:'101',time:100,jobId:'j1',text:'我想了解岗位',direction:'out'},
    {id:'102',time:190,text:'较新但归属待确认',direction:'out'},
    {id:'103',time:200,jobId:'j1',text:'对方已查看了您的附件简历',type:1,bodyType:4,direction:'in'},
    {id:'104',time:210,jobId:'j1',text:'对方撤回了一条消息',direction:'in'},
  ]);
  await collect('shared', 'j2', [{id:'105',time:160,jobId:'j2',text:'这边还在招聘',direction:'in'}]);
  await collect('system-only', 'j3', [{id:'301',time:250,text:'附件简历请求已发送',isSystem:true,direction:'out'}]);
  assert.deepEqual(await previews(), {
    '职位 j1':{text:'我想了解岗位',direction:'out'},
    '职位 j2':{text:'这边还在招聘',direction:'in'},
    '职位 j3':undefined,
  });
  await collect('other', 'j1', [{id:'401',time:201,text:'下周方便聊吗？',direction:'in'}]);
  await collect('other', 'j1', [{id:'402',time:90,text:'更早的消息',direction:'out'}]);
  assert.deepEqual((await previews())['职位 j1'], {text:'下周方便聊吗？',direction:'in'});
  await collect('other', 'j1', [{id:'403',time:202,text:'发送方没有记录的消息',direction:'unknown'}]);
  assert.deepEqual((await previews())['职位 j1'], {text:'发送方没有记录的消息',direction:'unknown'});
  const board = await h.get(A);
  assert.deepEqual(Object.fromEntries(board.jobs.map(job => [job.title, job.latestMessage])), {
    '职位 j1':{text:'发送方没有记录的消息',direction:'unknown',time:202},
    '职位 j2':{text:'这边还在招聘',direction:'in',time:160},
    '职位 j3':undefined,
  });
  await h.ingest(snapshot(A,[
    row('other','j1',{lastText:'列表里的新回复',lastIsSelf:false,lastMessageAt:310}),
    row('shared','j2',{lastText:'切换职位前的列表摘要',lastIsSelf:false,lastMessageAt:320}),
    row('withdrawn','j4',{lastText:'对方撤回了一条消息',lastIsSelf:false,lastMessageAt:330}),
  ]));
  const updated = Object.fromEntries((await h.get(A)).jobs.map(job => [job.title, job.latestMessage]));
  assert.deepEqual(updated['职位 j1'],{text:'列表里的新回复',direction:'in',time:310,fromList:true});
  assert.deepEqual(updated['职位 j2'],{text:'这边还在招聘',direction:'in',time:160});
  assert.equal(updated['职位 j4'],undefined);
  assert.deepEqual((await previews())['职位 j1'],{text:'发送方没有记录的消息',direction:'unknown'});
});

test('最新对话只为自己发出的消息显示已送达或已读，并匹配同一条摘要', async () => {
  const h = await harness();
  const site = {url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}};
  const text = '请问可以约下周吗？';
  const message = {id:'1',time:20,text,direction:'out',status:1};
  const collect = messages => h.ingest({type:'CONVERSATION',account:A,row:row('chat','j1'),messages});
  const summary = time => h.ingest(snapshot(A,[row('chat','j1',{lastText:text,lastIsSelf:true,lastMessageAt:time,lastMsgStatus:2})]));
  const board = async () => (await h.get(A)).jobs.find(job=>job.id===A+':job:j1').latestMessage;
  const widget = async () => (await h.send({type:'WIDGET_GET',account:A,jobId:'j1'},site)).data.jobs[0].latestMessage;
  await collect([message]);
  assert.equal((await board()).receipt,'delivered');
  await summary(10);
  assert.equal((await board()).receipt,'delivered');
  await summary(20);
  assert.equal((await board()).receipt,'read');
  assert.deepEqual(await widget(),{text,direction:'out',receipt:'read'});
  await collect([{...message,status:2}]);
  await collect([message,{...message,status:null}]);
  assert.equal((await board()).receipt,'read');
  await collect([{id:'2',time:30,text:'可以的',direction:'in',status:2}]);
  assert.equal((await board()).receipt,undefined);
  await collect([{id:'3',time:40,text:'谢谢',direction:'out',status:0}]);
  assert.equal((await board()).receipt,undefined);

  await h.ingest(snapshot(A,[row('list','j2',{lastText:'你好',lastIsSelf:true,lastMessageAt:50,lastMsgStatus:1})]));
  assert.deepEqual((await h.get(A)).jobs.find(job=>job.id===A+':job:j2').latestMessage,
    {text:'你好',direction:'out',time:50,fromList:true,receipt:'delivered'});
});

test('最新人工消息跳过资讯、联系方式和交互卡片，保留同样文字的普通聊天', async () => {
  const h = await harness();
  const site = {url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}};
  const wechatText = '模拟联系人的微信号：mock_wechat';
  const cards = [
    {id:'2',time:20,type:4,bodyType:16,templateId:1,messageType:'articles',text:'你与该职位竞争者PK情况'},
    {id:'3',time:30,type:1,bodyType:7,templateId:1,messageType:'dialog',text:'希望交换微信'},
    {id:'4',time:40,type:1,bodyType:1,templateId:5,messageType:'text',text:wechatText},
    {id:'5',time:45,type:1,bodyType:1,templateId:5,text:wechatText},
    {id:'6',time:50,type:1,bodyType:7,text:'希望获取您的附件简历'},
  ].map(message => ({...message,isSystem:false,direction:'in'}));
  const collect = (contact, job, messages) => h.ingest({type:'CONVERSATION',account:A,row:row(contact,job),messages});
  const previews = async () => {
    const response = await h.send({type:'WIDGET_GET',account:A,jobId:'j1'},site);
    assert.equal(response.ok,true,response.error);
    return Object.fromEntries(response.data.jobs.map(job => [job.id,job.latestMessage]));
  };
  await collect('chat','j1',[{id:'1',time:10,type:1,bodyType:1,direction:'out',text:'你好，请问方便沟通吗？'},...cards]);
  await collect('cards-only','j2',cards);
  assert.deepEqual(await previews(), {
    [A+':job:j1']:{text:'你好，请问方便沟通吗？',direction:'out'},
    [A+':job:j2']:undefined,
  });
  await collect('chat','j1',[{id:'7',time:60,type:1,bodyType:1,templateId:1,messageType:'text',direction:'in',text:wechatText}]);
  assert.deepEqual((await previews())[A+':job:j1'],{text:wechatText,direction:'in'});
});

test('浮窗按首次消息排序，历史页、多人及当前职位切换保持稳定',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}};
  const collect=(contact,job,messages,extra={})=>h.ingest({type:'CONVERSATION',account:A,row:row(contact,job,extra),messages});
  await collect('c1','b',[{id:'late',time:300},{id:'early',time:200}]);
  await collect('c2','b',[{id:'one',time:150}]);
  await collect('c3','a',[{id:'one',time:150}]);
  await h.ingest(snapshot(A,[row('c4','z'),row('c5','d')]));
  const widget=async(jobId,title)=>{const r=await h.send({type:'WIDGET_GET',account:A,jobId,companyName:'模拟公司',title},site);assert.equal(r.ok,true,r.error);return r.data.jobs;};
  const pairs=jobs=>jobs.map(j=>[j.id?.split(':job:')[1]??null,j.firstConversationAt]);
  const expected=[['a',150],['b',150],['d',0],['z',0]];
  assert.deepEqual(pairs(await widget('z')),expected);
  assert.deepEqual(pairs(await widget('a')),expected);
  assert.deepEqual(pairs(await widget('c','临时')), [['a',150],['b',150],['c',0],['d',0],['z',0]]);
  assert.deepEqual(pairs(await widget(undefined,'临时')), [...expected,[null,0]]);
  await collect('c1','b',[{id:'new',time:900},{id:'invalid',time:-2}],{lastMessageAt:900});
  await h.send({type:'SAVE_JOB',account:A,jobId:`${A}:job:b`,note:'更新',status:'passed'});
  assert.deepEqual(pairs(await widget('b')),expected);
  await collect('c1','b',[{id:'older',time:50}]);
  assert.deepEqual(pairs(await widget('a')),[['b',50],['a',150],['d',0],['z',0]]);
  assert.equal((await h.get(A)).conversations.find(c=>c.id.endsWith(':c1')).firstMessageAt,50);
});

test('旧数据从消息及双向关联回填，保留人工字段并更新旧关联和 pending',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}};
  const collect=(contact,job,time)=>h.ingest({type:'CONVERSATION',account:A,row:row(contact,job),messages:[{id:String(time),time}]});
  await collect('c1','j1',300);await collect('c2','j1',100);await collect('c3','j2',200);
  await h.send({type:'SAVE_JOB',account:A,jobId:`${A}:job:j1`,note:'保留',status:'passed'});
  await updateStored(h,'jobs',j=>{const {firstConversationAt,...rest}=j;return {...rest,conversationIds:j.id.endsWith('j1')?[`${A}:conversation:c1`]:[],conversationId:undefined,updatedAt:123};});
  await updateStored(h,'conversations',c=>{const {firstMessageAt,...rest}=c;return {...rest,jobIds:c.id.endsWith('c1')?[]:c.jobIds};});
  await updateStored(h,'meta',m=>m.id===`${A}:conversationOrderVersion`?null:m);
  const result=await h.send({type:'WIDGET_GET',account:A,jobId:'j1'},site);
  assert.deepEqual(result.data.jobs.map(j=>[j.id.split(':job:')[1],j.firstConversationAt]),[['j1',100],['j2',200]]);
  let jobs=(await h.get(A)).jobs;assert.equal(jobs[0].updatedAt,123);assert.equal(jobs[0].note,'保留');assert.equal(jobs[0].manualStatus,'passed');
  await collect('c1','j2',50);
  jobs=(await h.get(A)).jobs;assert.equal(jobs.find(j=>j.id.endsWith('j1')).firstConversationAt,50);assert.equal(jobs.find(j=>j.id.endsWith('j2')).firstConversationAt,50);
  await collect('pending','pending:pending',25);
  await h.ingest(snapshot(A,[row('pending','resolved')]));
  assert.equal((await h.get(A)).jobs.find(j=>j.id.endsWith('resolved')).firstConversationAt,25);
});

test('SAVE_JOB 允许网页修改状态和备注，仅状态变化记录事件并按设置恢复自动',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/job_detail/j1.html',tab:{id:3}},jobId=`${A}:job:j1`;
  await h.ingest(snapshot(A,[row('c1','j1',{lastIsSelf:false,lastText:'您好'})]));
  await h.bind(A,site);
  const initial=(await h.get(A)).events.length;
  const save=patch=>h.send({type:'SAVE_JOB',account:A,jobId,...patch},site);
  assert.equal((await save({status:'interviewing',note:'准备二面'})).ok,true);
  let data=await h.get(A),job=data.jobs[0];
  assert.equal(job.status,'interviewing');assert.equal(job.note,'准备二面');assert.equal(job.manual,true);
  assert.equal(data.events.length,initial+1);assert.equal(data.events.filter(e=>e.source==='manual'&&e.status==='interviewing').length,1);
  assert.equal((await save({status:'interviewing',note:'更新备注'})).ok,true);
  assert.equal((await save({note:''})).ok,true);
  data=await h.get(A);assert.equal(data.jobs[0].note,'');assert.equal(data.events.length,initial+1);
  assert.equal((await h.send({type:'SET_STATUS',account:A,jobId,status:'passed'},site)).ok,false);
  assert.equal((await save({status:'auto'})).ok,true);
  data=await h.get(A);job=data.jobs[0];
  assert.equal(job.status,'awaiting_self');assert.equal(job.manualStatus,null);assert.equal(job.manual,false);assert.equal(data.events.length,initial+2);
  assert.equal((await h.send({type:'SET_SETTINGS',account:A,interviewRounds:5})).ok,false);
  assert.equal((await save({status:'interviewing'})).ok,true);
  assert.equal((await save({status:'interview_6'})).ok,false);
  assert.deepEqual((await h.send({type:'WIDGET_GET',account:A,jobId:'j1'},site)).data.settings,{});
});

test('备注支持 10000 字、保存清空，WIDGET_GET 返回持久化备注',async()=>{
  const h=await harness(),site={url:'http://localhost:4173/web/geek/job',tab:{id:4}},jobId=`${A}:job:j1`,companyId=`${A}:company:模拟公司`,note='备'.repeat(10000);
  await h.ingest(snapshot(A,[row('c1','j1')]),site);
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,note})).ok,true);
  assert.equal((await h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId,note},site)).ok,true);
  const widget=await h.send({type:'WIDGET_GET',account:A,jobId:'j1'},site);
  assert.equal(widget.data.companyId,companyId);assert.equal(widget.data.companyNote,note);assert.equal(widget.data.jobs[0].note,note);assert.equal(widget.data.jobs[0].persisted,true);
  for(const invalid of [null,42,[],{},'x'.repeat(10001)]){
    assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,note:invalid,status:'passed'},site)).ok,false);
    assert.equal((await h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId,note:invalid})).ok,false);
  }
  assert.equal((await h.get(A)).jobs[0].status,'unknown');
  assert.equal((await h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId,note:''})).ok,true);
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,note:''},site)).ok,true);
  const cleared=await h.send({type:'WIDGET_GET',account:A,jobId:'j1'},site);
  assert.equal(cleared.data.companyNote,'');assert.equal(cleared.data.jobs[0].note,'');
});

test('SAVE_JOB 和公司备注拒绝未知账号、跨账号和不可信来源且不修改数据',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/job',tab:{id:3}};
  await h.ingest(snapshot(A,[row('a','j1')]));await h.ingest(snapshot(B,[row('b','j1')]));
  await h.bind(A,site);
  const beforeA=await h.get(A),beforeB=await h.get(B);
  const job={type:'SAVE_JOB',account:A,jobId:`${A}:job:j1`,note:'备注'},company={type:'SAVE_COMPANY_NOTE',account:A,companyId:`${A}:company:模拟公司`,note:'备注'};
  for(const message of [job,company]){
    for(const account of [undefined,null,'c'.repeat(24)])assert.equal((await h.send({...message,account},site)).ok,false);
    assert.equal((await h.send({...message,account:B},site)).ok,false);
    assert.equal((await h.send(message,{url:'https://example.com/web/geek/job',tab:{id:9}})).ok,false);
  }
  for(const patch of [{},{status:undefined},{status:null},{status:['passed']},{status:'interview_4'},{jobId:null,note:'a'},{jobId:`${A}:job:`,note:'a'}])assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId:job.jobId,...patch},site)).ok,false);
  assert.deepEqual(await h.get(A),beforeA);assert.deepEqual(await h.get(B),beforeB);
  // A corrupt record's account must also be checked independently of its key prefix.
  await updateStored(h,'jobs',j=>j.id===job.jobId?{...j,account:B}:j);
  assert.equal((await h.send(job,site)).ok,false);
  await updateStored(h,'companies',c=>c.id===company.companyId?{...c,account:B}:c);
  assert.equal((await h.send(company,site)).ok,false);
});

test('SAVE_JOB 状态与备注并发保存不丢字段，与自动采集串行合并',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/job',tab:{id:3}},jobId=`${A}:job:j1`,companyId=`${A}:company:模拟公司`;
  await h.ingest(snapshot(A,[row('c1','j1')]));
  await h.bind(A,site);
  const initial=(await h.get(A)).events.length;
  const results=await Promise.all([
    h.send({type:'SAVE_JOB',account:A,jobId,status:'passed'},site),
    h.send({type:'SAVE_JOB',account:A,jobId,note:'职位备注'},site),
    h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId,note:'公司备注'},site),
    h.ingest(snapshot(A,[row('c1','j1',{lastIsSelf:false,lastText:'您好'})])),
    h.send({type:'SAVE_JOB',account:A,jobId,status:'passed'},site)
  ]);
  assert.ok(results.every(r=>r.ok));
  const data=await h.get(A);assert.equal(data.jobs[0].status,'passed');assert.equal(data.jobs[0].autoStatus,'awaiting_self');assert.equal(data.jobs[0].note,'职位备注');assert.equal(data.companies[0].note,'公司备注');assert.equal(data.events.length,initial+1);
});

test('SAVE_JOB 事务写入失败回滚职位、备注、公司及事件，队列可继续使用',async()=>{
  const h=await harness(),jobId=`${A}:job:j1`;
  await h.ingest(snapshot(A,[row('c1','j1')]));
  const before=await h.get(A),put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){
    const request=put.apply(this,args);
    if(this.name==='events')request.addEventListener('success',()=>this.transaction.abort(),{once:true});
    return request;
  };
  try{
    assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,status:'passed',note:'应回滚'})).ok,false);
    assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId:`${A}:job:new`,status:'passed',note:'应回滚',context:{companyId:`${A}:company:新公司`,companyName:'新公司',title:'新职位'}})).ok,false);
  }finally{IDBObjectStore.prototype.put=put;}
  assert.deepEqual(await h.get(A),before);
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,note:'继续保存'})).ok,true);
  assert.equal((await h.get(A)).jobs[0].note,'继续保存');
});

test('临时 JD 用规范化公司信息创建本地记录，URL 仅来自允许来源且不虚构聊天',async()=>{
  const h=await harness(),site={url:'http://127.0.0.1:4173/job_detail/new.html',tab:{id:8}},companyId=`${A}:company:abc公司`,jobId=`${A}:job:new/../?url=https://example.com`;
  await h.ingest(snapshot(A,[]),site);
  const before=await h.get(A);
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,note:'待研究',status:'interviewing',context:{companyId,companyName:'  ＡＢＣ公司  ',title:'本地职位',url:'https://example.com/evil'}},site)).ok,true);
  let data=await h.get(A),job=data.jobs[0];
  assert.equal(job.id,jobId);assert.equal(job.companyId,companyId);assert.equal(job.autoStatus,'unknown');assert.equal(job.note,'待研究');assert.equal(job.status,'interviewing');assert.deepEqual(job.conversationIds,[]);assert.equal(job.conversationId,undefined);
  assert.equal(job.url,'http://127.0.0.1:4173/job_detail/'+encodeURIComponent(jobId.slice(`${A}:job:`.length))+'.html');
  assert.deepEqual(data.conversations,before.conversations);assert.deepEqual((await h.send({type:'EXPORT',account:A})).data.messages,[]);
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,note:'更新',context:{companyId:`${B}:company:其他`,title:'不应覆盖'}})).ok,true);
  data=await h.get(A);assert.equal(data.jobs[0].title,'本地职位');assert.equal(data.jobs[0].companyId,companyId);
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId:`${A}:job:second`,note:'',context:{companyId,title:'已有公司职位'}},site)).ok,true);
  const widget=await h.send({type:'WIDGET_GET',account:A,jobId:jobId.slice(`${A}:job:`.length)},site);
  assert.equal(widget.data.jobs.find(j=>j.id===jobId).persisted,true);assert.equal(widget.data.jobs.find(j=>j.id===jobId).note,'更新');
});

test('临时 JD 拒绝非法 ID 和上下文，公司备注只可按同账号规范化名称新建',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/job',tab:{id:3}},companyId=`${A}:company:新公司`,context={companyId,companyName:'新公司',title:'新职位'};
  await h.ingest(snapshot(A,[]));await h.ingest(snapshot(B,[]));await h.bind(A,site);
  const before=await h.get(A);
  for(const patch of [
    {jobId:null},{jobId:`${A}:job:`},{jobId:`${A}:job:  `},{jobId:`${A}:job:${'x'.repeat(200)}`},{jobId:`${B}:job:new`},
    {context:undefined},{context:[]},{context:{...context,title:''}},{context:{...context,title:'x'.repeat(201)}},
    {context:{...context,companyId:`${B}:company:新公司`}},{context:{...context,companyId:`${A}:company:错误`}},{context:{...context,companyName:' '}},{context:{...context,companyName:'x'.repeat(181)}}
  ])assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId:`${A}:job:new`,note:'备注',context,...patch},site)).ok,false,JSON.stringify(patch));
  for(const patch of [{companyId:`${B}:company:新公司`},{companyName:'错误'},{companyName:''},{companyName:'x'.repeat(181)},{companyName:undefined},{companyId:null}])assert.equal((await h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId,companyName:'新公司',note:'备注',...patch},site)).ok,false);
  assert.deepEqual(await h.get(A),before);
  assert.equal((await h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId:`${A}:company:abc`,companyName:' ＡＢＣ ',note:'独立公司备注'},site)).ok,true);
  const data=await h.get(A);assert.equal(data.companies.length,1);assert.equal(data.companies[0].note,'独立公司备注');assert.deepEqual(data.jobs,[]);assert.deepEqual(data.conversations,[]);
  assert.equal((await h.send({type:'WIDGET_GET',account:A,companyName:'ABC'},site)).data.companyNote,'独立公司备注');
  assert.equal((await h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId:`${A}:company:abc`,note:''})).ok,true);
  const widget=await h.send({type:'WIDGET_GET',account:A,companyName:'ABC'},site);assert.equal(widget.data.companyNote,'');
  const longId=await h.send({type:'WIDGET_GET',account:A,jobId:'x'.repeat(190),companyName:'新公司',title:'标题'},site);assert.equal(longId.data.jobs.at(-1).id,null);assert.equal(longId.data.jobs.at(-1).persisted,false);
});

test('自动采集和状态迁移保留职位、公司用户字段，pending JD 转正保留备注',async()=>{
  const h=await harness(),jobId=`${A}:job:j1`,companyId=`${A}:company:模拟公司`;
  await h.ingest(snapshot(A,[row('c1','j1')]));
  await h.send({type:'SAVE_JOB',account:A,jobId,note:'职位保留'});
  await h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId,note:'公司保留'});
  await updateStored(h,'companies',c=>({...c,userTag:'自定义字段'}));
  await updateStored(h,'jobs',j=>({...j,autoSchemaVersion:0}));
  let data=await h.get(A);assert.equal(data.jobs[0].note,'职位保留');assert.equal(data.companies[0].note,'公司保留');assert.equal(data.companies[0].userTag,'自定义字段');
  await updateStored(h,'jobs',j=>({...j,autoSchemaVersion:0}));
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,status:'auto'})).ok,true);
  assert.equal((await h.get(A)).jobs[0].note,'职位保留');
  await updateStored(h,'jobs',j=>({...j,id:`${A}:job:pending:c1`,note:'待定备注'}));
  await updateStored(h,'conversations',c=>({...c,jobId:undefined,jobIds:[`${A}:job:pending:c1`]}));
  await h.ingest(snapshot(A,[row('c1','resolved')]));
  data=await h.get(A);assert.equal(data.jobs.length,1);assert.equal(data.jobs[0].id,`${A}:job:resolved`);assert.equal(data.jobs[0].note,'待定备注');assert.equal(data.companies[0].note,'公司保留');assert.equal(data.companies[0].userTag,'自定义字段');
  await h.ingest(snapshot(A,[row('c1','resolved')]));assert.equal((await h.get(A)).jobs[0].note,'待定备注');
});

test('pending JD 合并保留目标、来源与已有冲突，去重并导出',async()=>{
  for(const target of ['目标备注','','来源备注']){
    const h=await harness(),pendingId=`${A}:job:pending:c1`,jobId=`${A}:job:resolved`;
    await h.ingest(snapshot(A,[row('c1','pending:c1'),row('other','resolved')]));
    await h.send({type:'SAVE_JOB',account:A,jobId,note:target});
    await h.send({type:'SAVE_JOB',account:A,jobId:pendingId,note:'来源备注'});
    await updateStored(h,'jobs',job=>job.id===pendingId?{...job,noteConflicts:[{sourceId:'之前',text:'更早的备注'}]}:job.id===jobId?{...job,noteConflicts:[{sourceId:pendingId,text:'来源备注'}]}:job);
    assert.equal((await h.ingest(snapshot(A,[row('c1','resolved')]))).ok,true);
    let job=(await h.send({type:'EXPORT',account:A})).data.jobs.find(j=>j.id===jobId);
    assert.equal(job.note,target||'来源备注');
    assert.deepEqual(job.noteConflicts,[{sourceId:pendingId,text:'来源备注'},{sourceId:'之前',text:'更早的备注'}]);
    assert.equal((await h.get(A)).jobs.some(j=>j.id===pendingId),false);
    await h.ingest(snapshot(A,[row('c1','resolved')]));
    job=(await h.send({type:'EXPORT',account:A})).data.jobs.find(j=>j.id===jobId);
    assert.equal(job.noteConflicts.length,2);
  }
  // Different notes create one conflict even when the target has none.
  const different=await harness(),differentPending=`${A}:job:pending:c1`,differentJob=`${A}:job:resolved`;
  await different.ingest(snapshot(A,[row('c1','pending:c1'),row('other','resolved')]));
  await different.send({type:'SAVE_JOB',account:A,jobId:differentPending,note:'来源'});
  await different.send({type:'SAVE_JOB',account:A,jobId:differentJob,note:'目标'});
  await different.ingest(snapshot(A,[row('c1','resolved')]));
  const merged=(await different.send({type:'EXPORT',account:A})).data.jobs.find(j=>j.id===differentJob);
  assert.equal(merged.note,'目标');assert.deepEqual(merged.noteConflicts,[{sourceId:differentPending,text:'来源'}]);
  // Without existing conflicts, equal notes must not create a redundant conflict.
  const h=await harness(),pendingId=`${A}:job:pending:c1`,jobId=`${A}:job:resolved`;
  await h.ingest(snapshot(A,[row('c1','pending:c1'),row('other','resolved')]));
  for(const id of [pendingId,jobId])await h.send({type:'SAVE_JOB',account:A,jobId:id,note:'相同'});
  await h.ingest(snapshot(A,[row('c1','resolved')]));
  assert.equal((await h.get(A)).jobs.find(j=>j.id===jobId).noteConflicts,undefined);
});

test('mock 不能冒充已识别真实账号采集或读写，重启后来源绑定仍有效',async()=>{
  const h=await harness(),real={url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}},mock={url:'http://127.0.0.1:4173/web/geek/chat',tab:{id:2}},jobId=`${A}:job:j1`,companyId=`${A}:company:模拟公司`;
  await h.ingest(snapshot(A,[row('c1','j1')]),real);
  await h.send({type:'SAVE_JOB',account:A,jobId,note:'真实职位'},real);
  await h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId,note:'真实公司'},real);
  await h.ingest(snapshot(B,[]),mock);
  const before=(await h.send({type:'EXPORT',account:A})).data;
  assert.equal((await h.ingest(snapshot(A,[row('evil','j1',{jobTitle:'伪造'})]),mock)).ok,false);
  for(const message of [
    {type:'WIDGET_GET',account:A,jobId:'j1'},
    {type:'SAVE_JOB',account:A,jobId,note:'伪造'},
    {type:'SAVE_COMPANY_NOTE',account:A,companyId,note:'伪造'},
    {type:'DB_GET',account:A},{type:'OPEN_DASHBOARD',account:A}
  ])assert.equal((await h.send(message,mock)).ok,false,message.type);
  assert.deepEqual((await h.send({type:'EXPORT',account:A})).data,before);
  const restarted=await harness({db:h.db});
  assert.equal((await restarted.ingest(snapshot(A,[row('evil','j1')]),mock)).ok,false);
  assert.equal((await restarted.send({type:'WIDGET_GET',account:A,jobId:'j1'},mock)).ok,false);
  assert.equal((await restarted.send({type:'WIDGET_GET',account:A,jobId:'j1'},real)).ok,true);
  await restarted.bind(A,real);
  assert.equal((await restarted.send({type:'WIDGET_GET',account:A,jobId:'j1'},real)).data.jobs[0].note,'真实职位');
  assert.deepEqual((await restarted.send({type:'EXPORT',account:A})).data,before);
  const local={url:'http://localhost:4173/web/geek/chat',tab:{id:2}};
  await restarted.bind(B,mock);
  assert.equal((await restarted.send({type:'DB_GET',account:B},local)).ok,true);
  assert.equal((await restarted.send({type:'DB_GET',account:A},local)).ok,false);
});

test('历史账号从职位 URL 确定来源；缺失或混合来源时拒绝任意重新绑定',async()=>{
  const h=await harness(),real={url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}},mock={url:'http://localhost:4173/web/geek/chat',tab:{id:2}};
  await h.ingest(snapshot(A,[row('c1','j1')]),real);
  await h.send({type:'SAVE_JOB',account:A,jobId:`${A}:job:j1`,note:'旧备注'});
  await updateStored(h,'meta',m=>m.id===`${A}:sourceGroup`?null:m);
  assert.equal((await h.ingest(snapshot(A,[row('c2','j2')]),mock)).ok,false);
  assert.equal((await h.send({type:'DB_GET',account:A},mock)).ok,false);
  assert.equal((await h.ingest(snapshot(A,[]),real)).ok,true);
  assert.equal((await h.send({type:'WIDGET_GET',account:A,jobId:'j1'},real)).data.jobs[0].note,'旧备注');
  await h.ingest(snapshot(B,[]),mock);
  await updateStored(h,'meta',m=>m.id===`${B}:sourceGroup`?null:m);
  for(const sender of [real,mock]){
    const result=await h.ingest(snapshot(B,[]),sender);assert.equal(result.ok,false);assert.match(result.error,/重新识别/);
    assert.equal((await h.send({type:'WIDGET_GET',account:B},sender)).ok,false);
  }
  assert.equal((await h.send({type:'DB_GET',account:B})).ok,true);
  await h.ingest(snapshot(A,[row('c2','j2')]),real);
  await updateStored(h,'jobs',j=>j.id===`${A}:job:j2`?{...j,url:'http://127.0.0.1:4173/job_detail/j2.html'}:j);
  await updateStored(h,'meta',m=>m.id===`${A}:sourceGroup`?null:m);
  assert.match((await h.ingest(snapshot(A,[]),real)).error,/重新识别/);
  assert.match((await h.ingest(snapshot(A,[]),mock)).error,/重新识别/);
});

test('UI 为 mock 账号新建职位使用 mock 来源，旧来源可从 URL 推导',async()=>{
  const h=await harness(),mock={url:'http://localhost:4173/web/geek/chat',tab:{id:2}},jobId=`${A}:job:new`,companyId=`${A}:company:新公司`;
  await h.ingest(snapshot(A,[]),mock);
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,note:'本地',context:{companyId,companyName:'新公司',title:'职位'}})).ok,true);
  assert.match((await h.get(A)).jobs[0].url,/^http:\/\/127\.0\.0\.1:4173\/job_detail\//);
  await updateStored(h,'meta',m=>m.id===`${A}:sourceGroup`?null:m);
  assert.equal((await h.ingest(snapshot(A,[]),{url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}})).ok,false);
  assert.equal((await h.ingest(snapshot(A,[]),mock)).ok,true);
});

test('同来源页面必须绑定对应账号，UI 仍可切换账号',async()=>{
  const h=await harness(),first={url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}},second={url:'https://www.zhipin.com/web/geek/job',tab:{id:2}};
  await h.ingest(snapshot(A,[row('a','j1')]),first);await h.ingest(snapshot(B,[]),second);
  for(const message of [{type:'WIDGET_GET',account:A},{type:'DB_GET',account:A},{type:'SAVE_JOB',account:A,jobId:`${A}:job:j1`,note:'x'},{type:'SAVE_COMPANY_NOTE',account:A,companyId:`${A}:company:模拟公司`,note:'x'},{type:'OPEN_DASHBOARD',account:A}])assert.equal((await h.send(message,second)).ok,false,message.type);
  assert.equal((await h.send({type:'SELECT_ACCOUNT',account:A})).ok,true);
  assert.equal((await h.send({type:'DB_GET',account:A})).ok,true);
  assert.equal((await h.send({type:'OPEN_DASHBOARD',account:A},first)).ok,true);
});

test('可选版本比较阻止备注和人工状态并发覆盖，兼容不带预期值的调用',async()=>{
  const h=await harness(),site={url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}},jobId=`${A}:job:j1`,companyId=`${A}:company:模拟公司`;
  await h.ingest(snapshot(A,[row('c1','j1')]),site);
  const saves=await Promise.all([
    h.send({type:'SAVE_JOB',account:A,jobId,note:'先保存',expectedNote:''},site),
    h.send({type:'SAVE_JOB',account:A,jobId,note:'过期保存',expectedNote:'',status:'passed',expectedManualStatus:null},site),
    h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId,note:'公司先保存',expectedNote:''},site),
    h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId,note:'公司过期',expectedNote:''},site)
  ]);
  assert.equal(saves[0].ok,true);assert.equal(saves[1].ok,false);assert.match(saves[1].error,/备注冲突/);
  assert.equal(saves[2].ok,true);assert.equal(saves[3].ok,false);assert.match(saves[3].error,/备注冲突/);
  let data=await h.get(A);assert.equal(data.jobs[0].note,'先保存');assert.equal(data.jobs[0].manualStatus,null);assert.equal(data.companies[0].note,'公司先保存');
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,status:'passed',expectedManualStatus:null},site)).ok,true);
  const before=await h.get(A);
  const stale=await h.send({type:'SAVE_JOB',account:A,jobId,status:'auto',note:'不能修改',expectedManualStatus:null,expectedNote:'先保存'},site);
  assert.equal(stale.ok,false);assert.match(stale.error,/状态冲突/);assert.deepEqual(await h.get(A),before);
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,status:'auto',expectedManualStatus:'passed'},site)).ok,true);
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,note:'兼容旧调用'},site)).ok,true);
  assert.equal((await h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId,note:'兼容旧调用'},site)).ok,true);
  data=await h.get(A);assert.equal(data.jobs[0].note,'兼容旧调用');assert.equal(data.companies[0].note,'兼容旧调用');
  for(const expectedNote of [null,42,undefined,'x'.repeat(10001)]){
    assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,note:'x',expectedNote},site)).ok,false);
    assert.equal((await h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId,note:'x',expectedNote},site)).ok,false);
  }
  for(const expectedManualStatus of [undefined,42,{},'auto','interview_11'])assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId,status:'passed',expectedManualStatus},site)).ok,false);
  assert.deepEqual(await h.get(A),data);
  assert.equal((await h.send({type:'SAVE_JOB',account:A,jobId:`${A}:job:new`,note:'x',expectedNote:'过期',context:{companyId,title:'新职位'}},site)).ok,false);
  assert.equal((await h.send({type:'SAVE_COMPANY_NOTE',account:A,companyId:`${A}:company:新`,companyName:'新',note:'x',expectedNote:'过期'},site)).ok,false);
  assert.deepEqual(await h.get(A),data);
});

test('后台重启后保留页面账号绑定，页面重新加载后旧绑定失效',async()=>{
  const h=await harness();await h.ingest(snapshot(A,[row('c1','j1')]));
  const restarted=await harness({db:h.db}),site={url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}};
  assert.equal((await restarted.send({type:'WIDGET_GET',account:A,jobId:'j1'},site)).ok,true);
  assert.equal((await restarted.send({type:'SAVE_JOB',account:A,jobId:`${A}:job:j1`,note:'重启后备注'},site)).ok,true);
  restarted.handlers.updated(1,{status:'loading'});await restarted.get(A);
  assert.equal((await restarted.send({type:'WIDGET_GET',account:A,jobId:'j1'},site)).ok,false);
});
test('手动面试状态在自动摄取后保留，恢复 auto 使用自动状态',async()=>{
  const h=await harness();
  await h.ingest(snapshot(A,[row('c1','j1',{lastIsSelf:true,lastText:'您好，我对这个职位感兴趣',lastMsgStatus:1})]));
  const jobId=(await h.get()).jobs[0].id;
  assert.equal((await h.send({type:'SET_STATUS',account:A,jobId,status:'interviewing'})).ok,true);
  await h.ingest(snapshot(A,[row('c1','j1',{lastIsSelf:true,lastText:'您好，我对这个职位感兴趣',lastMsgStatus:2})]));
  let job=(await h.get()).jobs[0];assert.equal(job.status,'interviewing');assert.equal(job.manual,true);assert.equal(job.autoStatus,'awaiting_boss');
  assert.equal((await h.send({type:'SET_STATUS',account:A,jobId,status:'auto'})).ok,true);
  job=(await h.get()).jobs[0];assert.equal(job.status,'awaiting_boss');assert.equal(job.manual,false);assert.equal(job.manualStatus,null);
});

test('读取总视图及恢复自动判断时主动迁移旧状态并保留手动标记',async()=>{
  const h=await harness();await h.ingest(snapshot(A,[row('c1','j1',{lastIsSelf:false,lastText:'您好',lastMessageAt:20})]));
  const jobId=(await h.get()).jobs[0].id;
  await h.send({type:'SET_STATUS',account:A,jobId,status:'interviewing'});
  await updateStored(h,'jobs',job=>{delete job.autoContributions;delete job.autoSchemaVersion;return {...job,autoStatus:'resume_viewed',autoLabel:'旧状态'};});
  let job=(await h.get()).jobs[0];assert.equal(job.autoSchemaVersion,6);assert.equal(job.autoStatus,'awaiting_self');assert.equal(job.status,'interviewing');
  await updateStored(h,'jobs',job=>({...job,autoSchemaVersion:4,autoStatus:'resume_sent',autoContributions:{old:{unverified:{status:'resume_sent'}}}}));
  job=(await h.get()).jobs[0];assert.equal(job.autoSchemaVersion,6);assert.equal(job.autoStatus,'awaiting_self');assert.equal(job.status,'interviewing');
  await updateStored(h,'jobs',job=>{delete job.autoContributions;delete job.autoSchemaVersion;return {...job,autoStatus:'resume_sent'};});
  assert.equal((await h.send({type:'SET_STATUS',account:A,jobId,status:'auto'})).ok,true);
  job=(await h.get()).jobs[0];assert.equal(job.status,'awaiting_self');assert.equal(job.manual,false);
});
test('列表方向必须有消息文本才能推断最近发言',async()=>{
  const h=await harness();
  await h.ingest(snapshot(A,[row('c1','j1',{lastIsSelf:true}),row('c2','j2',{lastIsSelf:false,lastText:'您好，请问方便聊聊吗？'})]));
  const jobs=(await h.get()).jobs;
  assert.equal(jobs.find(j=>j.id.endsWith('job:j1')).status,'unknown');
  assert.equal(jobs.find(j=>j.id.endsWith('job:j2')).status,'awaiting_self');
});

test('较晚的简历系统提示按时间选择，不沿用旧阶段排序',async()=>{
  const h=await harness();
  await h.ingest({type:'CONVERSATION',account:A,row:row('c1','j1'),messages:[
    {id:'viewed',isSystem:true,time:1,text:'对方已查看了您的附件简历'},
    {id:'sent',isSystem:true,time:2,text:'您的附件简历已发送给Boss'}
  ]});
  const job=(await h.get()).jobs[0];
  assert.equal(job.status,'resume_event');assert.equal(job.autoLabel,'您的附件简历已发送给Boss');
});

test('账号不能修改其他账号的职位',async()=>{
  const h=await harness();await h.ingest(snapshot(A,[row('c1','j1')]));await h.ingest(snapshot(B,[row('c2','j2')]));
  const jobId=(await h.get(A)).jobs[0].id;
  const result=await h.send({type:'SET_STATUS',account:B,jobId,status:'interviewing'});
  assert.equal(result.ok,false);assert.match(result.error,/找不到当前账号/);
  const job=(await h.get(A)).jobs[0];assert.equal(job.manual,false);assert.notEqual(job.status,'interviewing');
});

test('同一联系人关联两个职位时不把未标记的历史归给另一个职位',async()=>{
  const h=await harness();
  await h.ingest({type:'CONVERSATION',account:A,row:row('c1','j1'),messages:[{id:'m1',direction:'in',text:'想要你的附件简历'}]});
  assert.equal((await h.get()).jobs[0].status,'resume_requested');
  await h.ingest({type:'CONVERSATION',account:A,row:row('c1','j2'),messages:[]});
  const data=await h.get();assert.equal(data.conversations[0].jobIds.length,2);
  assert.equal(data.jobs.find(j=>j.id.endsWith('job:j1')).status,'unknown');
  assert.equal(data.jobs.find(j=>j.id.endsWith('job:j2')).status,'unknown');
});

test('A 和 B 同 JD，A 关联另一 JD 只撤销 A 的未验证贡献，B 证据与人工状态保持',async()=>{
  const h=await harness();
  assert.equal((await h.ingest({type:'CONVERSATION',account:A,row:row('contact-a','j1'),messages:[{id:'a1',isSystem:true,time:2,text:'对方已查看了您的附件简历'}]})).ok,true);
  assert.equal((await h.ingest({type:'CONVERSATION',account:A,row:row('contact-b','j1'),messages:[{id:'b1',jobId:'j1',isSystem:true,time:1,text:'您的附件简历已发送给Boss'}]})).ok,true);
  const jobId=`${A}:job:j1`,aId=`${A}:conversation:contact-a`,bId=`${A}:conversation:contact-b`;
  const before=(await h.get()).jobs.find(j=>j.id===jobId);
  assert.equal(before.autoStatus,'resume_event');assert.equal(before.autoLabel,'对方已查看了您的附件简历');
  assert.equal((await h.send({type:'SET_STATUS',account:A,jobId,status:'interviewing'})).ok,true);
  assert.equal((await h.ingest(snapshot(A,[row('contact-a','j2')]))).ok,true);
  let job=(await h.get()).jobs.find(j=>j.id===jobId);
  assert.equal(job.autoStatus,'resume_event');assert.equal(job.autoLabel,'您的附件简历已发送给Boss');assert.equal(job.status,'interviewing');assert.equal(job.manualStatus,'interviewing');assert.equal(job.manual,true);
  assert.equal(job.autoContributions[aId].unverified,undefined);
  assert.deepEqual(job.autoContributions[bId],before.autoContributions[bId]);
  assert.match(job.evidence,/您的附件简历已发送给Boss/);
  for(let i=0;i<2;i++){
    assert.equal((await h.ingest(snapshot(A,[row('contact-a','j1',{lastIsSelf:true,lastText:'您好',lastMsgStatus:2}),row('contact-b','j1',{unread:false})]))).ok,true);
    assert.equal((await h.ingest({type:'CONVERSATION',account:A,row:row('contact-b','j1'),messages:[]})).ok,true);
  }
  job=(await h.get()).jobs.find(j=>j.id===jobId);
  assert.equal(job.autoStatus,'resume_event');assert.equal(job.autoLabel,'您的附件简历已发送给Boss');assert.equal(job.status,'interviewing');
  assert.deepEqual(job.autoContributions[bId].verified,before.autoContributions[bId].verified);
  assert.equal((await h.send({type:'SET_STATUS',account:A,jobId,status:'auto'})).ok,true);
  job=(await h.get()).jobs.find(j=>j.id===jobId);assert.equal(job.status,'resume_event');assert.equal(job.autoLabel,'您的附件简历已发送给Boss');
});

test('另一联系人的未标记简历证据保留，同一批快照与重复采集不使状态倒退',async()=>{
  const h=await harness();
  await h.ingest(snapshot(A,[row('contact-a','j1')]));
  await h.ingest({type:'CONVERSATION',account:A,row:row('contact-b','j1'),messages:[{id:'b1',isSystem:true,time:1,text:'您的附件简历已发送给Boss'}]});
  assert.equal((await h.ingest(snapshot(A,[row('contact-a','j2'),row('contact-b','j1',{unread:true})]))).ok,true);
  const jobId=`${A}:job:j1`,bId=`${A}:conversation:contact-b`;
  let job=(await h.get()).jobs.find(j=>j.id===jobId);
  assert.equal(job.status,'resume_event');assert.equal(job.autoLabel,'您的附件简历已发送给Boss');assert.equal(job.autoContributions[bId].unverified.status,'resume_event');assert.equal(job.autoContributions[bId].unverified.label,'您的附件简历已发送给Boss');
  await h.ingest({type:'CONVERSATION',account:A,row:row('contact-b','j1'),messages:[]});
  job=(await h.get()).jobs.find(j=>j.id===jobId);
  assert.equal(job.status,'resume_event');assert.equal(job.autoLabel,'您的附件简历已发送给Boss');assert.equal(job.autoContributions[bId].unverified.status,'resume_event');assert.equal(job.autoContributions[bId].unverified.label,'您的附件简历已发送给Boss');
});

test('多 JD 联系人保留明确 JD 的历史贡献，并把新增明确证据更新到对应旧 JD',async()=>{
  const h=await harness(),jobId=`${A}:job:j1`,cid=`${A}:conversation:c1`;
  await h.ingest({type:'CONVERSATION',account:A,row:row('c1','j1'),messages:[{id:'m1',jobId:'j1',isSystem:true,time:1,text:'您的附件简历已发送给Boss'},{id:'m2',isSystem:true,time:2,text:'对方已查看了您的附件简历'}]});
  await h.ingest(snapshot(A,[row('c1','j2')]));
  let data=await h.get(),job=data.jobs.find(j=>j.id===jobId);
  assert.equal(job.autoStatus,'resume_event');assert.equal(job.autoLabel,'您的附件简历已发送给Boss');assert.equal(job.autoContributions[cid].unverified,undefined);
  assert.equal(data.jobs.find(j=>j.id===`${A}:job:j2`).autoStatus,'unknown');
  await h.ingest({type:'CONVERSATION',account:A,row:row('c1','j2'),messages:[{id:'m3',jobId:'j1',isSystem:true,time:3,text:'对方已查看了您的附件简历'}]});
  data=await h.get();job=data.jobs.find(j=>j.id===jobId);assert.equal(job.autoStatus,'resume_event');assert.equal(job.autoLabel,'对方已查看了您的附件简历');
  assert.equal(data.jobs.find(j=>j.id===`${A}:job:j2`).autoStatus,'unknown');
});

test('旧版多人 JD 从各自消息迁移，不把来源不明的高阶段归给最后联系人',async()=>{
  const h=await harness(),jobId=`${A}:job:j1`,aId=`${A}:conversation:contact-a`,bId=`${A}:conversation:contact-b`;
  await h.ingest(snapshot(A,[row('contact-a','j1')]));
  await h.ingest({type:'CONVERSATION',account:A,row:row('contact-b','j1'),messages:[{id:'b1',jobId:'j1',isSystem:true,time:1,text:'您的附件简历已发送给Boss'}]});
  await h.send({type:'SET_STATUS',account:A,jobId,status:'passed'});
  await updateStored(h,'jobs',job=>{delete job.autoContributions;return {...job,autoStatus:'resume_viewed',evidence:'来源不明的旧版高阶段'};});
  assert.equal((await h.ingest(snapshot(A,[row('contact-a','j2')]))).ok,true);
  const job=(await h.get()).jobs.find(j=>j.id===jobId);
  assert.equal(job.autoStatus,'resume_event');assert.equal(job.autoLabel,'您的附件简历已发送给Boss');assert.equal(job.status,'passed');assert.equal(job.manual,true);
  assert.equal(job.autoContributions[aId].unverified,undefined);
  assert.equal(job.autoContributions[bId].verified.status,'resume_event');assert.equal(job.autoContributions[bId].verified.label,'您的附件简历已发送给Boss');
  assert.ok(Object.values(job.autoContributions).every(c=>c.verified?.status!=='resume_viewed'&&c.unverified?.status!=='resume_viewed'));
});

test('旧版多人和单人无消息时均不继承旧简历状态',async()=>{
  const h=await harness(),jobId=`${A}:job:j1`;
  await h.ingest(snapshot(A,[row('contact-a','j1'),row('contact-b','j1')]));
  await updateStored(h,'jobs',job=>{delete job.autoContributions;return {...job,autoStatus:'resume_viewed',status:'resume_viewed'};});
  await h.ingest(snapshot(A,[row('contact-a','j1',{unread:false})]));
  let job=(await h.get()).jobs.find(j=>j.id===jobId);
  assert.equal(job.autoStatus,'unknown');assert.equal(job.status,'unknown');
  assert.equal(job.autoContributions[`${A}:conversation:contact-b`].unverified.status,'unknown');
  await h.ingest(snapshot(A,[row('single','single-job')]));
  await updateStored(h,'jobs',job=>{if(!job.id.endsWith('job:single-job'))return job;delete job.autoContributions;return {...job,autoStatus:'resume_sent',status:'resume_sent'};});
  await h.ingest(snapshot(A,[row('single','single-job')]));
  job=(await h.get()).jobs.find(j=>j.id.endsWith('job:single-job'));assert.equal(job.autoStatus,'unknown');assert.equal(job.status,'unknown');
  await h.ingest(snapshot(A,[row('single','another-job')]));
  job=(await h.get()).jobs.find(j=>j.id.endsWith('job:single-job'));assert.equal(job.autoStatus,'unknown');
});

test('旧记录仅保留最后联系人时按会话反向关联迁移，不能把多人高阶段归给最后一人',async()=>{
  const h=await harness(),jobId=`${A}:job:j1`;
  await h.ingest(snapshot(A,[row('contact-a','j1'),row('contact-b','j1')]));
  await updateStored(h,'jobs',job=>{delete job.autoContributions;delete job.conversationIds;return {...job,autoStatus:'resume_viewed',status:'resume_viewed'};});
  assert.equal((await h.ingest(snapshot(A,[row('contact-b','j1')]))).ok,true);
  const job=(await h.get()).jobs.find(j=>j.id===jobId);
  assert.equal(job.autoStatus,'unknown');assert.equal(job.status,'unknown');
  assert.deepEqual(Object.keys(job.autoContributions).sort(),[`${A}:conversation:contact-a`,`${A}:conversation:contact-b`]);
  assert.equal(job.conversationIds.length,2);
});

test('旧版缺失贡献与会话引用的数据安全降为未知并保留人工状态，空快照安全',async()=>{
  const h=await harness(),jobId=`${A}:job:j1`;
  await h.ingest(snapshot(A,[row('c1','j1')]));
  await h.send({type:'SET_STATUS',account:A,jobId,status:'failed'});
  await updateStored(h,'jobs',job=>{delete job.autoContributions;delete job.conversationIds;delete job.conversationId;return {...job,autoStatus:'resume_viewed'};});
  await updateStored(h,'conversations',()=>null);
  assert.equal((await h.ingest(snapshot(A,[]))).ok,true);
  assert.equal((await h.ingest(snapshot(A,[row('new-contact','j1')]))).ok,true);
  const job=(await h.get()).jobs.find(j=>j.id===jobId);
  assert.equal(job.autoStatus,'unknown');assert.equal(job.status,'failed');assert.equal(job.manual,true);
  assert.deepEqual(Object.keys(job.autoContributions),[`${A}:conversation:new-contact`]);
});

test('SYNC 找不到匹配账号的聊天页时拒绝发送同步指令',async()=>{
  const h=await harness();await h.ingest(snapshot(A,[]));
  h.tabs.push({id:2,url:'https://www.zhipin.com/web/geek/chat',active:true});
  const result=await h.send({type:'SYNC',account:A});
  assert.equal(result.ok,false);assert.match(result.error,/没有与该账号匹配/);
  assert.deepEqual(h.sent.map(x=>x.message.type),['ACCOUNT_INFO']);
});

test('非法消息结构被拒绝，批次不会产生部分数据或注册账号',async()=>{
  const h=await harness();
  const invalid=[
    snapshot(A,[row('c1','j1'),{id:'c2',jobId:42}]),
    {type:'CONVERSATION',account:A,row:row('c1','j1'),messages:[null]},
    {type:'SNAPSHOT',account:A,rows:'invalid'}
  ];
  for(const data of invalid){const result=await h.ingest(data);assert.equal(result.ok,false);}
  const data=await h.get();assert.equal(data.account,null);assert.deepEqual(data.accounts,[]);
  for(const name of ['companies','jobs','conversations','events']) assert.deepEqual(data[name],[]);
});

test('采集间隔按账号持久化，仅允许扩展页保存，在启动时传给聊天页',async()=>{
  const h=await harness();
  await h.ingest(snapshot(A,[]));
  await h.ingest(snapshot(B,[]),{url:'https://www.zhipin.com/web/geek/chat',tab:{id:2}});
  assert.equal((await h.get(A)).syncIntervalSeconds,3);
  for(const intervalSeconds of [0,31,3.5,'12',null]){
    assert.equal((await h.send({type:'SET_SYNC_INTERVAL',account:A,intervalSeconds})).ok,false);
  }
  assert.equal((await h.send({type:'SET_SYNC_INTERVAL',account:A,intervalSeconds:12},{url:'https://www.zhipin.com/web/geek/chat',tab:{id:1}})).ok,false);
  assert.equal((await h.send({type:'SET_SYNC_INTERVAL',account:A,intervalSeconds:12})).ok,true);
  const restarted=await harness({db:h.db});
  assert.equal((await restarted.get(A)).syncIntervalSeconds,12);
  assert.equal((await restarted.get(B)).syncIntervalSeconds,3);
  await restarted.ingest(snapshot(A,[]));
  restarted.tabs.push({id:1,active:true});
  assert.equal((await restarted.send({type:'SYNC',account:A,intervalSeconds:3})).ok,true);
  assert.equal(restarted.sent.find(entry=>entry.message.type==='SYNC').message.intervalSeconds,12);
});

test('同账号互斥，停止发送到启动标签，旧任务和其他标签的进度被拒绝',async()=>{
  const h=await harness();
  await h.ingest(snapshot(A,[]));
  await h.ingest(snapshot(A,[]),{url:'https://www.zhipin.com/web/geek/chat',tab:{id:2}});
  h.tabs.push({id:1,active:true},{id:2,active:false});
  const start=await h.send({type:'SYNC',account:A});assert.equal(start.ok,true);
  assert.equal((await h.send({type:'SYNC',account:A})).ok,false);
  h.tabs[0].active=false;h.tabs[1].active=true;
  assert.equal((await h.send({type:'STOP_SYNC',account:A})).ok,true);
  const stop=h.sent.find(x=>x.message.type==='STOP_SYNC');assert.equal(stop.id,1);assert.equal(stop.message.runId,start.runId);
  const progress={type:'SYNC_PROGRESS',account:A,runId:start.runId,sync:{running:false,complete:true}};
  assert.equal((await h.ingest(progress,{url:'https://www.zhipin.com/web/geek/chat',tab:{id:2}})).ok,false);
  assert.equal((await h.ingest(progress)).ok,true);
  assert.equal((await h.get(A)).sync.complete,false);
  assert.equal((await h.ingest(progress)).ok,false);
  const next=await h.send({type:'SYNC',account:A});assert.equal(next.ok,true);assert.notEqual(next.runId,start.runId);
  assert.equal((await h.ingest(progress)).ok,false);
});

test('同时启动时同账号只有一个获得任务，不同账号可各自启动',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const h=await harness({onSend:async(id,message)=>{if(message.type==='SYNC')await gate;return {ok:true};}});
  await h.ingest(snapshot(A,[]));
  await h.ingest(snapshot(B,[]),{url:'https://www.zhipin.com/web/geek/chat',tab:{id:2}});
  h.tabs.push({id:1,active:true},{id:2,active:false});
  const first=h.send({type:'SYNC',account:A}),second=h.send({type:'SYNC',account:A}),other=h.send({type:'SYNC',account:B});
  for(let i=0;i<50&&h.sent.filter(x=>x.message.type==='SYNC').length<2;i++)await new Promise(r=>setTimeout(r,2));
  release();const results=await Promise.all([first,second,other]);
  assert.equal(results.slice(0,2).filter(x=>x.ok).length,1);assert.equal(results[2].ok,true);
  assert.deepEqual(h.sent.filter(x=>x.message.type==='SYNC').map(x=>x.id).sort(),[1,2]);
});

test('启动时页面等待后台提交不会与串行队列死锁',async()=>{
  let h;
  h=await harness({onSend:async(id,message)=>{
    if(message.type==='SYNC'){
      const result=await h.ingest({type:'SYNC_PROGRESS',account:A,runId:message.runId,requestId:'p',sync:{running:true,complete:false}});
      assert.equal(result.ok,true);
    }
    return {ok:true};
  }});
  await h.ingest(snapshot(A,[]));h.tabs.push({id:1,active:true});
  const result=await Promise.race([h.send({type:'SYNC',account:A}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('deadlock')),500))]);
  assert.equal(result.ok,true);assert.equal((await h.get(A)).sync.running,true);
});

test('worker 重启后恢复运行绑定，标签关闭识别为中断',async()=>{
  const first=await harness();await first.ingest(snapshot(A,[]));first.tabs.push({id:1,active:true});
  const start=await first.send({type:'SYNC',account:A});
  const restarted=await harness({db:first.db});
  const state=(await restarted.get(A)).sync;assert.equal(state.runId,start.runId);assert.equal(state.tabId,1);assert.equal(state.running,true);
  assert.equal((await restarted.send({type:'STOP_SYNC',account:A})).ok,true);
  assert.equal(restarted.sent[0].id,1);assert.equal(restarted.sent[0].message.runId,start.runId);
  restarted.handlers.removed(1);
  const interrupted=(await restarted.get(A)).sync;assert.equal(interrupted.running,false);assert.equal(interrupted.interrupted,true);
});

test('重启后过期任务被标记为中断并拒绝旧进度',async()=>{
  const first=await harness();await first.ingest(snapshot(A,[]));first.tabs.push({id:1,active:true});
  const start=await first.send({type:'SYNC',account:A});
  const db=await new Promise((resolve,reject)=>{const req=first.db.open('boss-local-helper',2);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction('meta','readwrite');const store=tx.objectStore('meta');const req=store.get(`${A}:sync`);req.onsuccess=()=>store.put({...req.result,value:{...req.result.value,updatedAt:Date.now()-100000}});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
  db.close();const restarted=await harness({db:first.db});
  const state=(await restarted.get(A)).sync;assert.equal(state.running,false);assert.equal(state.interrupted,true);
  const result=await restarted.ingest({type:'SYNC_PROGRESS',account:A,runId:start.runId,sync:{running:true,complete:false}});
  assert.equal(result.ok,false);
});

test('被动观察保留每次运行的连续覆盖证明，失败后已提交页仍在',async()=>{
  const h=await harness();await h.ingest(snapshot(A,[]));h.tabs.push({id:1,active:true});
  const start=await h.send({type:'SYNC',account:A});
  const page=(runId,pages,end,id)=>({type:'CONVERSATION',account:A,runId,requestId:'r'+id,row:row('c1','j1'),messages:[{id,text:id}],history:{runId,pages,serverReportsEnd:end,continuousFromStart:true,count:pages}});
  assert.equal((await h.ingest(page(start.runId,1,false,'m1'))).ok,true);
  assert.equal((await h.ingest(page(start.runId,3,true,'bad'))).ok,false);
  await h.ingest({type:'CONVERSATION',account:A,row:row('c1','j1'),history:{observedEnd:true},messages:[]});
  let history=(await h.get(A)).conversations[0].history;
  assert.equal(history.pages,1);assert.equal(history.serverReportsEnd,false);assert.equal(history.observedEnd,true);assert.equal(history.syncRuns[start.runId].pages,1);
  await h.ingest({type:'SYNC_PROGRESS',account:A,runId:start.runId,sync:{running:false,complete:false,failed:1}});
  const next=await h.send({type:'SYNC',account:A});
  assert.equal((await h.ingest(page(next.runId,1,true,'m2'))).ok,true);
  history=(await h.get(A)).conversations[0].history;
  assert.equal(history.runId,next.runId);assert.equal(history.syncRuns[start.runId].pages,1);assert.equal(history.syncRuns[next.runId].serverReportsEnd,true);
  const exported=await h.send({type:'EXPORT',account:A});assert.deepEqual(exported.data.messages.map(m=>m.messageId).sort(),['m1','m2']);
});
