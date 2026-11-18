import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {createWorld, jobPageFixtures} from '../../mock/fixtures.ts';

const source=await readFile(new URL('../../extension/dist/main.js',import.meta.url),'utf8');

function harness(origin='https://www.zhipin.com'){
  const output=[],requests=[],elements=new Map();
  const root=()=>({nodes:new Map(),querySelectorAll(selector){return selector.split(', ').flatMap(part=>this.nodes.get(part)||[]);}});
  const detail=root(),card=root(),document=root();
  const user={__vue__:{$store:{state:{userInfo:{userId:7}}}}};
  document.nodes=elements;
  elements.set('*',[user]);elements.set('.job-detail-box',[detail]);elements.set('.job-card-box.active',[card]);
  const documentEvents={};document.addEventListener=(name,handler)=>{documentEvents[name]=handler;};
  document.querySelector=selector=>document.querySelectorAll(selector)[0]||null;
  const location={origin,pathname:'/web/geek/jobs'};
  let listener;
  const window={addEventListener:(name,handler)=>{if(name==='message')listener=handler;},postMessage:event=>output.push(event.data),fetch:async url=>{requests.push(url);return {clone:()=>({json:async()=>({code:0,zpData:{messages:[]}})})};}};
  function XHR(){}
  XHR.prototype.open=function(){};XHR.prototype.send=function(){};
  vm.runInNewContext(source,{window,document,location,XMLHttpRequest:XHR,crypto:webcrypto,TextEncoder,URL,setTimeout,clearTimeout});
  const textNode=textContent=>({textContent});
  function select({id='j1',company='示例公司',title='前端',vue=true}={}){
    detail.__vue__=vue?{jobInfo:{encryptId:id,brandName:company,jobName:title}}:undefined;
    detail.nodes.set('.job-name',[textNode(title)]);detail.nodes.set('.company-name',[textNode(company)]);
    card.nodes.set('a[href*="/job_detail/"]',id?[{getAttribute:()=>'/job_detail/'+id+'.html?lid=test'}]:[]);
  }
  async function snapshot(){
    listener({source:window,origin,data:{channel:'boss-local-helper-v1',direction:'to-page',data:{type:'SNAPSHOT'}}});
    await new Promise(resolve=>setTimeout(resolve,20));
    return output.at(-1);
  }
  return {output,requests,elements,detail,card,document,documentEvents,location,window,select,snapshot,textNode};
}

test('真实收藏页只读职位收藏列表，忽略推荐与公司收藏，并在成功移除后取消标记',async()=>{
  const h=harness();h.location.pathname='/web/geek/recommend';
  h.elements.set('[ka="personal_top_interest"].current',[{}]);h.elements.set('[ka="personal_sub_position_focus"].current',[{}]);
  const nodes={'.company-info [ka^="personal_interest_brand_"]':h.textNode('收藏公司'),'.job-info a.name':{getAttribute:()=>'/job_detail/favorite-1.html?securityId=discard'},'.job-name-text':h.textNode('收藏职位')};
  const card={querySelector:selector=>nodes[selector]||null};h.elements.set('.user-jobs-ul .item-boss',[card]);
  const result=await h.snapshot();assert.equal(result.type,'FAVORITES');assert.equal(result.rows.length,1);assert.equal(result.rows[0].jobId,'favorite-1');assert.equal(result.rows[0].favorite,true);assert.ok(!JSON.stringify(result).includes('securityId'));
  h.documentEvents.click({target:{closest:()=>({closest:()=>card})}});
  await h.snapshot();assert.equal(h.output.at(-1).rows[0].favorite,true);
  h.elements.set('.user-jobs-ul .item-boss',[]);
  const removed=await h.snapshot();assert.equal(removed.rows[0].favorite,false);
  const count=h.output.length;h.elements.delete('[ka="personal_sub_position_focus"].current');await h.snapshot();assert.equal(h.output.length,count);
});

test('收藏页首次快照前快速取消也能识别账号并上报取消',async()=>{
  const h=harness();h.location.pathname='/web/geek/recommend';
  h.elements.set('[ka="personal_top_interest"].current',[{}]);h.elements.set('[ka="personal_sub_position_focus"].current',[{}]);
  const nodes={'.company-info [ka^="personal_interest_brand_"]':h.textNode('收藏公司'),'.job-info a.name':{getAttribute:()=>'/job_detail/fast-cancel.html'},'.job-name-text':h.textNode('收藏职位')};
  const card={querySelector:selector=>nodes[selector]||null};h.elements.set('.user-jobs-ul .item-boss',[card]);
  h.documentEvents.click({target:{closest:()=>({closest:()=>card})}});
  h.elements.set('.user-jobs-ul .item-boss',[]);
  const result=await h.snapshot();assert.equal(result.type,'FAVORITES');assert.equal(result.rows.length,1);assert.equal(result.rows[0].jobId,'fast-cancel');assert.equal(result.rows[0].favorite,false);
});

test('真实职位页外层容器不带Vue，内层props.data包含JD与独立公司信息',async()=>{
  const h=harness();
  h.elements.set('.job-detail-container',[{querySelectorAll:()=>[]}]);
  h.detail.__vue__={$props:{data:{jobInfo:{encryptId:'didi-job',jobName:'前端工程师'},brandComInfo:{brandName:'滴滴'}}}};
  const context=await h.snapshot();
  assert.equal(context.jobId,'didi-job');assert.equal(context.companyName,'滴滴');assert.equal(context.title,'前端工程师');
});

test('mock的完整职位数据交给原MAIN识别，详情滞后时仍跟随当前卡片且不采集',async()=>{
  const fixtures=jobPageFixtures(createWorld());
  const h=harness('http://127.0.0.1:4173');
  h.elements.delete('.job-card-box.active');h.elements.set('.job-card-wrap.active',[h.card]);
  h.elements.set('.job-detail-container',[{querySelectorAll:()=>[]}]);
  h.detail.__vue__={$options:{name:'JodCardDetail'},$props:{data:fixtures.details[fixtures.cases.existing],loading:false}};
  for(const id of [fixtures.cases.existing,fixtures.cases.companyOnly,fixtures.cases.unknownCompany,fixtures.cases.sameTitleDifferentId]){
    const row=fixtures.rows.find(row=>row.encryptJobId===id);
    h.card.__vue__={$options:{name:'JodCard'},$props:{data:row,isActive:true}};
    h.detail.__vue__.$props.loading=true;
    const current=await h.snapshot();
    assert.equal(current.jobId,row.encryptJobId);assert.equal(current.companyName,row.brandName);assert.equal(current.title,row.jobName);
    h.detail.__vue__.$props.data=fixtures.details[id];h.detail.__vue__.$props.loading=false;
    await h.snapshot();
  }
  assert.ok(h.output.every(event=>event.type==='PAGE_CONTEXT'));
  assert.equal(h.requests.length,0);
});

test('真实选中卡片用boss-name展示公司，切换期间不混用上个详情的公司或JD',async()=>{
  const h=harness();h.select({id:'old',company:'旧公司',title:'旧职位'});
  h.elements.delete('.job-card-box.active');h.elements.set('.job-card-wrap.active',[h.card]);
  h.card.nodes.set('.boss-name',[h.textNode('滴滴')]);h.card.nodes.set('.job-name',[h.textNode('前端工程师')]);
  h.card.nodes.set('a[href*="/job_detail/"]',[{getAttribute:()=>'/job_detail/didi-job.html?lid=test'}]);
  const context=await h.snapshot();
  assert.equal(context.jobId,'didi-job');assert.equal(context.companyName,'滴滴');assert.equal(context.title,'前端工程师');
});

test('职位列表识别当前详情、切换职位与空选择，仅发布PAGE_CONTEXT且不主动请求',async()=>{
  for(const origin of ['https://www.zhipin.com','http://127.0.0.1:4173','http://localhost:4173']){
    const h=harness(origin);h.select();
    assert.equal((await h.snapshot()).jobId,'j1');
    h.select({id:'j2',company:'另一家公司',title:'后端'});
    const changed=await h.snapshot();assert.equal(changed.jobId,'j2');assert.equal(changed.companyName,'另一家公司');assert.equal(changed.title,'后端');
    const count=h.output.length;await h.snapshot();assert.equal(h.output.length,count);
    h.elements.delete('.job-detail-box');
    const cleared=await h.snapshot();assert.equal(cleared.jobId,'');assert.equal(cleared.companyName,'');assert.equal(cleared.title,'');
    assert.ok(h.output.every(event=>event.type==='PAGE_CONTEXT'));
    assert.equal(h.requests.length,0);
  }
});

test('职位列表无Vue数据时从选中卡片链接识别ID，忽略隐藏详情',async()=>{
  const h=harness();h.select({id:'job-from-link',vue:false});
  assert.equal((await h.snapshot()).jobId,'job-from-link');
  h.detail.getClientRects=()=>[];
  assert.equal((await h.snapshot()).jobId,'');
});

test('独立职位详情页也只提供上下文，网页聊天接口响应不会摄取为对话',async()=>{
  const h=harness();h.select();
  h.location.pathname='/job_detail/j1.html';
  h.elements.set('.job-banner h1',[h.textNode('前端')]);
  h.elements.set('.sider-company .company-info a',[h.textNode(''),h.textNode('示例公司')]);
  const context=await h.snapshot();assert.equal(context.companyName,'示例公司');assert.equal(context.jobId,'j1');
  await h.window.fetch(h.location.origin+'/wapi/zpchat/geek/getBossData?bossId=c1');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(h.output.every(event=>event.type==='PAGE_CONTEXT'));
});
