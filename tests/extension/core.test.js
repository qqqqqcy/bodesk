import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inferStatus,mergeAutoContribution,mergeJob,validStatus} from '../../extension/dist/core.js';

const msg=(text,time,extra={})=>({text,time,...extra});
const system=(text,time,extra={})=>msg(text,time,{isSystem:true,...extra});

test('平台面试邀约和接受卡片进入面试中，取消后恢复之前的沟通状态',()=>{
  const card = (text,time,extra={}) => msg(text,time,{type:3,bodyType:14,templateId:1,...extra});
  const resume = system('对方已查看了您的附件简历',10);
  const invite = card('模拟招聘方邀请您线上面试，如需取消面试请联系招聘方',20,{direction:'in'});
  const accepted = card('接受了面试邀请',30,{direction:'out',isSystem:false,messageType:'interview'});
  const cancelled = card('对方取消了面试',40,{direction:'in',isSystem:false});
  assert.equal(inferStatus({},[resume,invite]).status,'interviewing');
  assert.equal(inferStatus({},[resume,invite,accepted]).observedAt,30);
  assert.equal(inferStatus({lastText:cancelled.text,lastMessageAt:40,lastIsSelf:false},[invite,accepted,cancelled,resume]).status,'resume_event');
  assert.equal(inferStatus({},[cancelled,card('模拟招聘方邀请您现场面试',50)]).status,'interviewing');
  assert.equal(inferStatus({},[msg('您好，这边是线上面试，您有兴趣沟通么',10,{direction:'in',type:3,bodyType:1,templateId:1})]).status,'awaiting_self');
  assert.equal(inferStatus({},[msg('接受了面试邀请',10,{direction:'out',type:1,bodyType:1,templateId:1})]).status,'awaiting_boss');
  assert.equal(inferStatus({},[card('未接受面试邀请',10)]).status,'unknown');
  const closed = {verified:inferStatus({},[invite]),unverified:inferStatus({},[cancelled,resume])};
  assert.equal(mergeJob(null,{autoContributions:{sameContact:closed}}).status,'resume_event');
  assert.equal(mergeJob(null,{autoContributions:{sameContact:closed,otherContact:{verified:inferStatus({},[accepted])}}}).status,'interviewing');
});

test('latest resume system event wins; ambiguous timestamp ties remain unknown',()=>{
  const viewed=system('对方已查看了您的附件简历',1);
  const sent=system('您的附件简历已发送给Boss',2);
  assert.deepEqual(inferStatus({},[viewed,sent]),{status:'resume_event',label:'您的附件简历已发送给Boss',observedAt:2,evidence:'系统消息：您的附件简历已发送给Boss',priority:3});
  assert.equal(inferStatus({},[system('附件简历请求已发送',2),sent]).status,'unknown');
  assert.match(inferStatus({},[system('附件简历请求已发送',0),sent]).evidence,/缺失时间/);
  assert.equal(inferStatus({},[sent,system('您的附件简历已发送给Boss',2)]).status,'resume_event');
  for(const text of ['您的在线简历已发送给Boss','您的产品经理简历已发送给Boss','对方已查看了你的附件简历','Boss已查看了您的附件简历','对方已同意，您的附件简历已发送给对方']) assert.equal(inferStatus({},[system(text,3)]).label,text);
});
test('only system flags or known legacy signatures identify system labels',()=>{
  for(const extra of [{type:1,bodyType:4},{type:3,bodyType:1,templateId:3},{type:4,bodyType:1,templateId:3}]) assert.equal(inferStatus({},[msg('附件简历请求已发送',1,extra)]).status,'resume_event');
  for(const extra of [{direction:'in'},{direction:'out',type:1,bodyType:4,isSystem:false},{direction:'in',type:3,bodyType:1,templateId:3,isSystem:false}]) assert.notEqual(inferStatus({},[msg('附件简历请求已发送',1,extra)]).status,'resume_event');
  for(const text of ['例如“附件简历请求已发送”','我说过您的附件简历已发送给Boss']) assert.notEqual(inferStatus({},[system(text,1)]).status,'resume_event');
  for(const text of ['您的附件简历未发送给Boss','对方没有查看您的附件简历','附件简历发送失败']) assert.equal(inferStatus({},[system(text,1)]).label,text);
});
test('竞争分析卡片和列表摘要不能产生待回复，也不能覆盖真人消息',()=>{
  const text='你与该职位竞争者PK情况';
  const preview={lastText:text,lastIsSelf:false,lastMessageAt:20};
  const card=msg(text,20,{type:4,bodyType:16,templateId:1,direction:'in',isSystem:false});
  assert.equal(inferStatus(preview).status,'unknown');
  assert.equal(inferStatus(preview,[card]).status,'unknown');
  assert.equal(inferStatus(preview,[msg('您好',10,{direction:'out'}),card]).status,'awaiting_boss');
});

test('只比较特殊状态的先后，之后的普通对话和列表新消息均不能覆盖',()=>{
  const special=[system('附件简历请求已发送',10),system('对方已查看了您的附件简历',20)];
  for(const [direction,lastIsSelf] of [['in',false],['out',true]]){
    const result=inferStatus({lastIsSelf,lastText:'好的，谢谢',lastMessageAt:100},[...special,msg('好的，谢谢',80,{direction})]);
    assert.equal(result.status,'resume_event');assert.equal(result.label,'对方已查看了您的附件简历');assert.equal(result.observedAt,20);
  }
  const quotedLater=msg('您的附件简历已发送给Boss',90,{direction:'out',isSystem:false});
  assert.equal(inferStatus({},[...special,quotedLater]).label,'对方已查看了您的附件简历');
});
test('未知简历系统标签不被较旧的已识别标签或回复状态掩盖',()=>{
  const older=system('附件简历请求已发送',1),unknown=system('对方正在审核您的附件简历',2);
  const result=inferStatus({},[older,unknown]);assert.equal(result.status,'unknown');assert.match(result.evidence,/正在审核/);assert.equal(result.priority,3);
  assert.equal(mergeJob({}, {autoContributions:{a:{unverified:result},b:{unverified:inferStatus({},[msg('你好',3,{direction:'in'})])}}}).autoStatus,'unknown');
  assert.equal(inferStatus({},[unknown,system('附件简历请求已发送',3)]).status,'resume_event');
  assert.equal(inferStatus({},[system('Boss希望获取您的附件简历',4)]).status,'resume_requested');
});
test('event, request, then latest actual communication have descending priority',()=>{
  const conversation=[msg('你好',30,{direction:'out'}),msg('请发一下附件简历',20,{direction:'in'}),system('附件简历请求已发送',10)];
  assert.equal(inferStatus({},conversation).priority,3);
  assert.equal(inferStatus({},conversation.slice(0,2)).status,'resume_requested');
  assert.equal(inferStatus({},[msg('',3,{direction:'in',type:1,bodyType:7})]).status,'awaiting_self');
  assert.equal(inferStatus({},[msg('希望获取您的附件简历',3,{direction:'in',type:1,bodyType:7})]).status,'resume_requested');
  assert.equal(inferStatus({},[msg('对方请求交换联系方式',3,{direction:'in',type:1,bodyType:7})]).status,'awaiting_self');
  assert.equal(inferStatus({},[msg('还没收到简历，麻烦再发一下附件简历',3,{direction:'in'})]).status,'resume_requested');
  assert.equal(inferStatus({},[msg('请发送作品集附件',10,{direction:'in'}),msg('已经发给您了',20,{direction:'out'})]).status,'awaiting_boss');
  for(const text of ['不需要发简历','不要发送附件简历','附件简历已发送','例如“请发简历”']) assert.equal(inferStatus({},[msg(text,2,{direction:'in'})]).status,'awaiting_self');
  assert.equal(inferStatus({},[msg('请发简历',2,{direction:'out'})]).status,'awaiting_boss');
});
test('direction follows latest communication, excluding system messages and using explicit list evidence',()=>{
  assert.equal(inferStatus({},[msg('您好',1,{direction:'in'}),msg('你好',2,{direction:'out'}),system('系统通知',3)]).status,'awaiting_boss');
  assert.equal(inferStatus({},[msg('你好',1,{direction:'out'}),msg('您好',2,{direction:'in'})]).status,'awaiting_self');
  assert.equal(inferStatus({lastIsSelf:false,lastText:'新消息',lastMessageAt:3},[msg('你好',2,{direction:'out'})]).status,'awaiting_self');
  assert.equal(inferStatus({lastIsSelf:null,lastText:'新消息',lastMessageAt:3},[msg('你好',2,{direction:'out'})]).status,'unknown');
  assert.equal(inferStatus({lastIsSelf:false,lastText:'附件简历请求已发送',lastMessageAt:3},[msg('你好',2,{direction:'out'})]).status,'unknown');
  assert.equal(inferStatus({lastIsSelf:false,lastText:'您好',time:5}).observedAt,5);
  assert.equal(inferStatus({lastIsSelf:true,lastText:'您好'}).status,'awaiting_boss');
  for(const row of [{},{unread:true},{lastIsSelf:true},{lastText:'您好'},{lastIsSelf:null,lastText:'您好'}]) assert.equal(inferStatus(row).status,'unknown');
  assert.equal(inferStatus({lastIsSelf:false,lastText:'系统通知'},[system('系统通知',3)]).status,'unknown');
  assert.equal(inferStatus({},[msg('缺少方向',3,{direction:'unknown'})]).status,'unknown');
  assert.equal(inferStatus({},[msg('尚未确认的系统卡片',3,{direction:'in',type:3,bodyType:12})]).status,'unknown');
  assert.equal(inferStatus({lastIsSelf:false,lastText:'对方撤回了一条消息',lastMessageAt:3},[msg('您好',2,{direction:'out'}),msg('对方撤回了一条消息',3,{direction:'in'})]).status,'awaiting_boss');
  assert.equal(inferStatus({},[msg('对方撤回了一条消息',3,{direction:'in'})]).status,'unknown');
});
test('complete observations replace the same source even when the stage or direction changes',()=>{
  const old={verified:inferStatus({},[system('对方已查看了您的附件简历',1)]),unverified:inferStatus({},[msg('你好',2,{direction:'out'})])};
  const next={verified:inferStatus({},[msg('你好',3,{direction:'in'})]),unverified:inferStatus({},[msg('您好',4,{direction:'in'})])};
  assert.deepEqual(mergeAutoContribution(old,next),next);
  assert.deepEqual(mergeAutoContribution(old,next,true),{verified:next.verified});
  assert.deepEqual(mergeAutoContribution(null,{}),{});
});
test('contacts aggregate by business priority then time, independently per job, with manual status preserved',()=>{
  const a={verified:inferStatus({},[system('附件简历请求已发送',1)])};
  const b={unverified:inferStatus({},[msg('请发简历',9,{direction:'in'})])};
  const first=mergeJob({manualStatus:'interviewing',conversationIds:['a']},{autoContributions:{a,b},conversationIds:['b']});
  assert.equal(first.autoStatus,'resume_event');assert.equal(first.status,'interviewing');assert.equal(first.manual,true);
  assert.deepEqual(first.conversationIds,['a','b']);
  const changed=mergeAutoContribution(a,{verified:inferStatus({},[msg('您好',10,{direction:'in'})])});
  const next=mergeJob(first,{autoContributions:{a:changed,b}});
  assert.equal(next.autoStatus,'resume_requested');assert.equal(next.status,'interviewing');
  const other=mergeJob(null,{autoContributions:{a:changed}});
  assert.equal(other.status,'awaiting_self');assert.equal(first.autoStatus,'resume_event');
  const later=mergeJob({}, {autoContributions:{a:changed,b:{verified:inferStatus({},[msg('回复',11,{direction:'out'})])}}});
  assert.equal(later.autoStatus,'awaiting_boss');assert.equal(later.observedAt,11);
  assert.equal(mergeJob(first,{autoContributions:{}}).autoStatus,'unknown');
  const ambiguous=mergeJob({}, {autoContributions:{a:{verified:inferStatus({},[system('附件简历请求已发送',5)])},b:{verified:inferStatus({},[system('您的附件简历已发送给Boss',5)])}}});
  assert.equal(ambiguous.autoStatus,'unknown');assert.match(ambiguous.evidence,/时间相同/);
});
test('canonical interviewing status is valid, legacy interview rounds are not writable',()=>{
  for(const status of ['resume_viewed','resume_sent','resume_event','awaiting_self','awaiting_boss','passed']) assert.ok(validStatus(status));
  assert.ok(validStatus('interviewing'));for(const value of ['interview_1','interview_4','interview_0','anything'])assert.ok(!validStatus(value));
  assert.equal(mergeJob({manualStatus:'resume_viewed'},{autoStatus:'awaiting_self'}).status,'resume_viewed');
  assert.equal(mergeJob({autoStatus:'resume_sent'},{autoStatus:'awaiting_self'}).autoStatus,'awaiting_self');
  assert.equal(mergeJob({}, {autoContributions:{a:{verified:{status:'resume_viewed',evidence:'旧记录'}}}}).autoStatus,'resume_viewed');
});

test('communication rejection is manual only and survives automatic observations',()=>{
  assert.ok(validStatus('communication_rejected'));
  const refusal=inferStatus({},[msg('对方拒绝沟通',10,{direction:'in'})]);
  assert.equal(refusal.status,'awaiting_self');
  assert.notEqual(inferStatus({},[system('对方拒绝沟通',10)]).status,'communication_rejected');
  const job=mergeJob({manualStatus:'communication_rejected'},{autoContributions:{a:{verified:refusal}}});
  assert.equal(job.status,'communication_rejected');assert.equal(job.manual,true);assert.equal(job.autoStatus,'awaiting_self');
  const next=mergeJob(job,{autoContributions:{a:{verified:inferStatus({},[system('对方已查看了您的附件简历',20)])}}});
  assert.equal(next.status,'communication_rejected');assert.equal(next.autoStatus,'resume_event');
});
