import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../../extension/dist/main.js',import.meta.url),'utf8');
function harness({switchOnResponse=false,ack=true,failPage=0,pages=1,empty=false,loaded=true,unreadCount=2,responseFor,clockNow,origin='https://www.zhipin.com'}={}){
  let uid=7;const output=[],requests=[],times=[];let listener;
  const start=performance.now(),clock=()=>Math.floor((performance.now()-start)*1000);
  const row={encryptBossId:'boss-test',securityId:'not-persisted-test-value',encryptJobId:'job-test',name:'test',brandName:'Example',unreadCount,lastIsSelf:false};
  const user={$store:{state:{get userInfo(){return {userId:uid};}}},$options:{name:'App'}};
  const list={$options:{name:'boss-list'},fullList:empty?[]:[row],bottomText:loaded?'没有更多了':'',isLoading:!loaded};
  const document={documentElement:null,addEventListener(){},querySelector:()=>null,querySelectorAll:selector=>selector==='*'?[{__vue__:user},{__vue__:list}]:[]};
  const window={postMessage:event=>{const d=event.data;output.push(d);if(d.requestId&&(typeof ack==='function'?ack(d):ack)){const ok=d.type!=='CONVERSATION'||d.history.pages!==failPage;setTimeout(()=>reply(d,ok),0);}},addEventListener:(name,fn)=>{if(name==='message')listener=fn;},fetch:async url=>{const u=new URL(url);requests.push(u);times.push(clock());if(switchOnResponse)uid=8;const custom=responseFor?.(u,requests.length);if(custom)return custom;const page=Number(u.searchParams.get('page')); const data=url.includes('getBossData')?{data:{encryptJobId:'job-test'},job:{jobName:'Test JD',brandName:'Example'}}:{hasMore:page<pages,minMsgId:page,messages:[{mid:page,time:1,from:{uid:100},to:{uid:7},body:{text:'hello'},status:2}]};return {ok:true,json:async()=>({code:0,zpData:data})};}};
  function XHR(){} XHR.prototype.open=function(){};XHR.prototype.send=function(){};
  const context={window,document,location:{origin,pathname:'/web/geek/chat'},XMLHttpRequest:XHR,crypto:webcrypto,TextEncoder,URL,AbortController,performance:{now:clockNow||clock},setTimeout:(fn,ms)=>setTimeout(fn,ms===15000?30:Math.ceil(ms/1000)),clearTimeout,setInterval,MutationObserver:class{observe(){}}};
  vm.runInNewContext(source,context);
  const mock=origin==='http://127.0.0.1:4173'||origin==='http://localhost:4173';
  const account=createHash('sha256').update((mock?'boss:mock:':'boss:')+'7').digest('hex').slice(0,24);
  const deliver=data=>listener({source:window,origin,data:{channel:'boss-local-helper-v1',direction:'to-page',data}});
  const reply=(d,ok=true)=>deliver({type:'INGEST_ACK',requestId:d.requestId,account:d.account,runId:d.runId,ok,error:ok?undefined:'模拟写入失败'});
  const command=(type,id,runId='run-a')=>deliver({type,commandId:id,account,runId});
  return {output,requests,times,command,reply,account};
}
async function settled(h){for(let i=0;i<400;i++){if(h.output.some(d=>d.type==='SYNC_PROGRESS'&&!d.sync.running))return;await new Promise(r=>setTimeout(r,5));}throw new Error('sync did not settle');}
test('two simultaneous updates serialize and make only allowlisted read requests',async()=>{
  const h=harness();h.command('SYNC','a');h.command('SYNC','b');await settled(h);
  assert.equal(h.output.filter(d=>d.type==='COMMAND_RESULT'&&d.ok).length,1);
  assert.equal(h.output.filter(d=>d.type==='COMMAND_RESULT'&&!d.ok).length,1);
  assert.deepEqual(h.requests.map(u=>u.pathname),['/wapi/zpchat/geek/getBossData','/wapi/zpchat/geek/historyMsg']);
  const record=h.output.find(d=>d.type==='CONVERSATION');assert.ok(record);assert.ok(record.requestId);assert.equal(record.history.runId,'run-a');assert.equal(record.history.continuousFromStart,true);assert.equal(record.history.serverReportsEnd,true);
  assert.ok(!JSON.stringify(record).includes('not-persisted-test-value'));
});
test('历史接口保留系统简历标签及附件请求卡片的内容和消息方向',async()=>{
  const h=harness({responseFor:u=>u.pathname.endsWith('historyMsg')?{ok:true,json:async()=>({code:0,zpData:{hasMore:false,minMsgId:1,messages:[
    {mid:1,time:1,type:1,from:{uid:100},to:{uid:7},body:{type:7,dialog:{title:'请求',content:'希望获取您的附件简历'}}},
    {mid:2,time:2,type:3,from:{uid:100},to:{uid:7},body:{type:1,templateId:3,text:'您的附件简历已发送给Boss'}}
  ]}})}:null});
  h.command('SYNC','a');await settled(h);
  const messages=h.output.find(d=>d.type==='CONVERSATION').messages;
  assert.equal(messages[0].direction,'in');assert.match(messages[0].text,/获取您的附件简历/);
  assert.equal(messages[1].isSystem,true);assert.match(messages[1].text,/简历已发送/);
});
test('account changed during request discards its response instead of assigning it to the old account',async()=>{
  const h=harness({switchOnResponse:true});h.command('SYNC','a');await settled(h);
  assert.equal(h.output.filter(d=>d.type==='CONVERSATION').length,0);
  assert.ok(h.output.some(d=>d.type==='SYNC_ERROR'));
});

test('下一页等待对应的数据库确认，被动消息不能充当确认',async()=>{
  const h=harness({pages:2,ack:d=>d.type!=='CONVERSATION'});h.command('SYNC','a');
  for(let i=0;i<50&&!h.output.some(d=>d.type==='CONVERSATION');i++)await new Promise(r=>setTimeout(r,2));
  const page=h.output.find(d=>d.type==='CONVERSATION');assert.ok(page);
  h.reply({...page,requestId:'passive'});
  await new Promise(r=>setTimeout(r,5));assert.equal(h.requests.filter(u=>u.pathname.endsWith('historyMsg')).length,1);
  h.reply(page);
  for(let i=0;i<50&&h.output.filter(d=>d.type==='CONVERSATION').length<2;i++)await new Promise(r=>setTimeout(r,2));
  const second=h.output.filter(d=>d.type==='CONVERSATION')[1];assert.ok(second);h.reply(second);await settled(h);
  assert.equal(h.output.findLast(d=>d.type==='SYNC_PROGRESS').sync.complete,true);
});

test('写入失败或确认超时计失败，不能读取下一页或报告成功',async()=>{
  for(const options of [{failPage:1},{ack:d=>d.type!=='CONVERSATION'}]){
    const h=harness({...options,pages:2});h.command('SYNC','a');await settled(h);
    assert.equal(h.requests.filter(u=>u.pathname.endsWith('historyMsg')).length,1);
    const final=h.output.findLast(d=>d.type==='SYNC_PROGRESS').sync;
    assert.equal(final.failed,1);assert.equal(final.complete,false);
  }
});

test('确定已加载的空列表成功，加载中不能假成功',async()=>{
  const empty=harness({empty:true});empty.command('SYNC','a');await settled(empty);
  const final=empty.output.findLast(d=>d.type==='SYNC_PROGRESS').sync;
  assert.equal(final.total,0);assert.equal(final.complete,true);assert.equal(empty.requests.length,0);
  const loading=harness({empty:true,loaded:false});loading.command('SYNC','a');
  for(let i=0;i<50&&!loading.output.some(d=>d.type==='COMMAND_RESULT');i++)await new Promise(r=>setTimeout(r,2));
  assert.equal(loading.output.find(d=>d.type==='COMMAND_RESULT').ok,false);
  assert.equal(loading.output.some(d=>d.type==='SYNC_PROGRESS'&&d.sync.complete),false);
});

test('缺失或非数字未读数保持未知，数字零才表示已读',async()=>{
  for(const [value,expected] of [[null,null],['0',null],[NaN,null],[0,false],[2,true]]){
    const h=harness({unreadCount:value});h.command('SYNC','a');await settled(h);
    assert.equal(h.output.find(d=>d.type==='CONVERSATION').row.unread,expected);
  }
});


test('主动请求至少间隔三秒，每完成二十次休息二十秒',async()=>{
  const h=harness({pages:21});h.command('SYNC','a');await settled(h);
  assert.equal(h.requests.length,22);
  assert.ok(h.times[0]>=3000,'新页面首次请求应先等待');
  for(let i=1;i<h.times.length;i++)assert.ok(h.times[i]-h.times[i-1]>=2900,`请求 ${i+1} 间隔不足`);
  assert.ok(h.times[20]-h.times[19]>=19500);
  assert.ok(h.output.some(d=>d.type==='SYNC_PROGRESS'&&d.sync.message.includes('休息 20 秒')));
  assert.equal(h.output.findLast(d=>d.type==='SYNC_PROGRESS').sync.complete,true);
});

test('精确匹配 mock 地址时使用专用账号并跳过请求间隔和周期休息',async()=>{
  const mock=harness({origin:'http://127.0.0.1:4173',pages:21});
  const localhost=harness({origin:'http://localhost:4173'});
  const real=harness();
  assert.notEqual(mock.account,real.account);
  assert.equal(localhost.account,mock.account);
  mock.command('SYNC','mock');await settled(mock);
  assert.equal(mock.requests.length,22);
  assert.equal(mock.output.findLast(d=>d.type==='SYNC_PROGRESS').sync.complete,true);
  assert.ok(mock.output.filter(d=>d.type==='CONVERSATION').every(d=>d.account===mock.account));
  assert.ok(!mock.output.some(d=>d.type==='SYNC_PROGRESS'&&/正在等待|休息 20 秒/.test(d.sync.message)));
  localhost.command('SYNC','localhost');await settled(localhost);
  assert.equal(localhost.output.findLast(d=>d.type==='SYNC_PROGRESS').sync.complete,true);
  assert.ok(!localhost.output.some(d=>d.type==='SYNC_PROGRESS'&&/正在等待|休息 20 秒/.test(d.sync.message)));
  const other=harness({origin:'http://localhost:5173'});
  other.command('SYNC','other');await settled(other);
  assert.equal(other.account,real.account);
  assert.ok(other.times[0]>=3000);
});

test('mock 收到 429 后仍停止当次采集，但可立即手动重试',async()=>{
  const h=harness({origin:'http://127.0.0.1:4173',responseFor:()=>({ok:false,status:429,headers:{get:()=> '600'}})});
  h.command('SYNC','first');await settled(h);
  assert.match(h.output.findLast(d=>d.type==='SYNC_PROGRESS').sync.message,/429/);
  await new Promise(resolve=>setTimeout(resolve,10));
  h.command('SYNC','second','run-b');
  for(let i=0;i<100&&h.output.filter(d=>d.type==='SYNC_PROGRESS'&&!d.sync.running).length<2;i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(h.output.find(d=>d.type==='COMMAND_RESULT'&&d.commandId==='second')?.ok,true);
  assert.equal(h.requests.length,2);
  assert.equal(h.output.filter(d=>d.type==='SYNC_PROGRESS'&&!d.sync.running).length,2);
});

test('风控、异常响应和网络故障立即中止，保留已确认的页面',async()=>{
  const bad=[
    {ok:false,status:401},{ok:false,status:403},{ok:false,status:429},{ok:false,status:500},
    {ok:true,redirected:true},
    {ok:true,json:async()=>{throw new Error('invalid JSON');}},
    {ok:true,json:async()=>({code:37})},
    {ok:true,json:async()=>({code:0,zpData:{messages:'invalid',hasMore:true}})},
  ];
  for(const response of bad){
    const h=harness({pages:3,responseFor:(u,n)=>n===3?response:null});h.command('SYNC','a');await settled(h);
    assert.equal(h.requests.length,3);
    assert.equal(h.output.filter(d=>d.type==='CONVERSATION').length,1);
    const final=h.output.findLast(d=>d.type==='SYNC_PROGRESS').sync;
    assert.equal(final.complete,false);assert.equal(final.failed,1);assert.match(final.message,/中止/);
  }
  const h=harness({responseFor:()=>Promise.reject(new Error('网络故障'))});h.command('SYNC','a');await settled(h);
  assert.equal(h.requests.length,1);assert.match(h.output.findLast(d=>d.type==='SYNC_PROGRESS').sync.message,/网络故障/);
});

test('限流后手动重启也不会立即重试，并遵守 Retry-After',async()=>{
  const h=harness({responseFor:()=>({ok:false,status:429,headers:{get:()=> '600'}})});
  h.command('SYNC','first');await settled(h);
  await new Promise(r=>setTimeout(r,10));
  h.command('SYNC','second','run-b');
  for(let i=0;i<100&&!h.output.some(d=>d.type==='COMMAND_RESULT'&&d.commandId==='second');i++)await new Promise(r=>setTimeout(r,2));
  const retry=h.output.find(d=>d.type==='COMMAND_RESULT'&&d.commandId==='second');
  assert.equal(retry?.ok,false);assert.match(retry.error,/等待/);
  assert.ok(Number(retry.error.match(/等待 (\d+)/)?.[1])>=500,'应遵循服务端要求的 600 秒等待');
  assert.equal(h.requests.length,1);
});
test('首次等待期间可停止，完全不发送请求',async()=>{
  const h=harness({clockNow:()=>0,ack:d=>{
    if(d.type==='SYNC_PROGRESS'&&d.sync.message.includes('正在等待'))queueMicrotask(()=>h.command('STOP_SYNC','stop'));
    return true;
  }});
  h.command('SYNC','a');await settled(h);
  assert.equal(h.requests.length,0);
  const final=h.output.findLast(d=>d.type==='SYNC_PROGRESS').sync;
  assert.equal(final.failed,0);assert.equal(final.complete,false);assert.match(final.message,/已停止/);
});
test('等待期间停止立即生效，不再发请求且不报告错误',async()=>{
  const h=harness({pages:3,ack:d=>{
    if(d.type==='SYNC_PROGRESS'&&d.sync.message.includes('正在等待')&&h.requests.length>=1)queueMicrotask(()=>h.command('STOP_SYNC','stop'));
    return true;
  }});
  h.command('SYNC','a');await settled(h);
  assert.equal(h.requests.length,1);
  assert.equal(h.output.filter(d=>d.type==='SYNC_ERROR').length,0);
  const final=h.output.findLast(d=>d.type==='SYNC_PROGRESS').sync;
  assert.equal(final.failed,0);assert.equal(final.complete,false);assert.match(final.message,/已停止/);
});
