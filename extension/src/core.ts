import type {Contribution, Contributions, JobRecord, MessageRecord, ConversationRecord} from './types.ts';

export const BASE_STATUSES = ['unknown','unread','read','greeting_unread','greeting_read','resume_requested','resume_applied','resume_sent','resume_viewed','resume_event','awaiting_self','awaiting_boss','communication_rejected','interviewing','passed','failed'];
export const validStatus = (value: string) => BASE_STATUSES.includes(value);

// Legacy values remain comparable when reading contributions saved by older versions.
const priorities: Record<string, number> = {unknown:0,unread:1,read:1,greeting_unread:1,greeting_read:1,awaiting_self:1,awaiting_boss:1,resume_requested:2,resume_applied:3,resume_sent:3,resume_viewed:3,resume_event:3,interviewing:4};
const priorityOf = (value?: Contribution) => typeof value?.priority==='number'&&Number.isInteger(value.priority)&&value.priority>=0&&value.priority<=4?value.priority:(priorities[value?.status || 'unknown'] ?? 0);
const timeOf = (value?: Contribution) => Number.isFinite(Number(value?.observedAt)) ? Number(value?.observedAt) : 0;
const messageTime = (m: MessageRecord) => Number.isFinite(Number(m.time)) ? Number(m.time) : 0;
const isSystem = (m: MessageRecord) => m.isSystem !== false && (m.isSystem === true || Number(m.type) === 1 && Number(m.bodyType) === 4 || [3,4].includes(Number(m.type)) && Number(m.bodyType) === 1 && Number(m.templateId) === 3);
export const isWithdrawn = (text: unknown) => /(?:撤回了一条消息|撤回了一条|消息已撤回|已撤回一条消息|撤回了消息)/.test(String(text||''));
const isInterviewCard = (message: MessageRecord) => message.messageType === 'interview' || (Number(message.type) === 3 && Number(message.bodyType) === 14 && Number(message.templateId) === 1);
const isHuman = (m: MessageRecord) => !isInterviewCard(m) && !isSystem(m) && !isWithdrawn(m.text) && (m.isSystem === false || (m.type == null && m.bodyType == null) || ([1,3].includes(Number(m.type)) && Number(m.bodyType) === 1 && Number(m.templateId) !== 3) || (Number(m.type) === 1 && Number(m.bodyType) === 7));

export function isChatMessage(message: MessageRecord) {
  if (!isHuman(message)) return false;
  if (message.messageType && !['text', 'image'].includes(message.messageType)) return false;
  if (message.bodyType == null) return true;
  const bodyType = Number(message.bodyType);
  const type = Number(message.type);
  const templateId = Number(message.templateId);
  if (bodyType === 1) return !(type === 1 && templateId === 5) && !([3, 4].includes(type) && templateId === 3);
  return bodyType === 3;
}
const questionable = (text: string) => /(?:不想|不需要|不要|无需|不用|不必|不能|无法|未|没有|没|尚未|取消|失败|并非|不是|别|如果|假如|例如|比如|[“”「」『』"'])/.test(text);

const resumeStages = [
  ['resume_applied', /^附件简历请求已发送$/],
  ['resume_sent', /^(?:对方已同意[，,]\s*)?(?:您的|你的).{0,30}简历已发送给\s*(?:Boss|对方)$/i],
  ['resume_viewed', /^(?:对方|Boss|BOSS)已查看了?(?:您的|你的)(?:附件|在线)?简历$/i],
] as const;

export const resumeEventStage = (label: string) => resumeStages.find(([, pattern]) => pattern.test(label))?.[0];

function resumeLabel(text: unknown) {
  const value=String(text || '').trim();
  // System labels may contain other card content; only accept a complete label line.
  for (const line of value.split(/\n+/).map(s=>s.trim().replace(/[。！!]+$/,''))) {
    if (/(?:如果|假如|例如|比如|我说过|[“”「」『』"'])/.test(line)) continue;
    if (resumeEventStage(line)) return line;
    // Preserve other explicit platform status labels, including failure or cancellation.
    if (line.length<=160 && /(?:简历.{0,45}(?:已发送|发送成功|已查看|被查看|已接收|已收到|已同意|已拒绝|已过期|已撤回|已失效|已取消|发送失败|未发送|未查看|已投递|请求被拒绝)|(?:已查看|查看了|已接收|已收到|已拒绝|已同意|已撤回|已发送|已投递|已取消|发送失败|没有查看|未查看).{0,45}简历)/.test(line)) return line;
  }
  return null;
}
function isSystemResumeRequest(m: MessageRecord) {
  if (!isSystem(m)) return false;
  return String(m.text||'').split(/\n+/).some(line=>!questionable(line)&&/(?:对方|Boss|BOSS).{0,18}(?:请求|希望|想要|索要|需要|获取).{0,20}简历/i.test(line));
}
function unrecognizedResumeNotice(m: MessageRecord) {
  if (!isSystem(m)) return '';
  return String(m.text||'').split(/\n+/).map(s=>s.trim()).find(line=>/简历/.test(line)&&/(?:请求|发送|查看|审核|收到|获取|撤回|拒绝|失败|过期|取消|处理|送达|接收|同意|失效|已读|投递|转发|转交|下载)/.test(line)&&!/(?:如果|假如|例如|比如|我说过|[“”「」『』"'])/.test(line))||'';
}
function isRequest(m: MessageRecord) {
  if (m.direction !== 'in' || !isHuman(m)) return false;
  const parts=String(m.text || '').split(/[，,。；;！？!?\n]+/).map(s=>s.trim()).filter(Boolean);
  return parts.some(text=>{
    if (!/简历/.test(text) || questionable(text) || /(?:已发送|发送成功|已发出|已查看)/.test(text)) return false;
    if (Number(m.type) === 1 && Number(m.bodyType) === 7) return /(?:请求|交换|索要|想要|希望|获取|索取|提供|发送|发|要)/.test(text);
    return /(?:请求|希望|想要|需要|索要).{0,12}(?:附件简历|发(?:送)?(?:一份|一下|你的|您的)*简历)|(?:请|麻烦|方便|可以|能否|能不能).{0,12}(?:发|发送|提供).{0,12}(?:附件|简历)|^(?:请)?发(?:送)?(?:一份|一下|你的|您的)*简历$|(?:发|发送).{0,8}附件简历/.test(text);
  });
}
function interviewCardState(message: MessageRecord) {
  if (!isInterviewCard(message)) return;
  const text = String(message.text || '').trim();
  if (isWithdrawn(text)) return;
  if (/(?:已(?:取消|拒绝|撤销)|(?:取消|拒绝|撤销)了)(?:本次|您的|你的|对方的)?面试|面试(?:邀请|邀约)?(?:已取消|已拒绝|已撤销|已过期|已失效)/.test(text)) return 'closed';
  if (/邀请(?:您|你|对方)(?:参加)?(?:线上|线下|视频|电话|现场)?面试/.test(text) || /^(?:(?:您|你|我|对方)?已?(?:接受|同意|确认)(?:了)?面试(?:邀请|邀约)|面试邀请|面试邀约|面试已确认)(?:$|[\s，。！])/.test(text)) return 'active';
}

export function inferStatus(row: ConversationRecord={}, messages: MessageRecord[]=[]): Contribution {
  const ordered = [...messages].sort((a, b) => messageTime(b) - messageTime(a));
  let latestInterview: {state: 'active' | 'closed'; time: number; text: string} | undefined;
  for (const message of ordered) {
    const state = interviewCardState(message);
    if (!state) continue;
    const time = messageTime(message);
    if (!latestInterview || (latestInterview.time === time && state === 'closed')) latestInterview = {state, time, text: String(message.text).trim()};
  }
  if (latestInterview?.state === 'active') return {status:'interviewing',label:'面试中',observedAt:latestInterview.time,evidence:'面试卡片：'+latestInterview.text.slice(0,300),priority:4};
  const preview = String(row.lastText || '').trim();
  const cardPreview = preview && ordered.some(message => isInterviewCard(message) && String(message.text || '').split('\n').some(line => line.trim() === preview));
  const fallback = inferCommunicationStatus(cardPreview ? {...row,lastText:''} : row, ordered);
  return latestInterview ? {...fallback, interviewClosedAt:latestInterview.time} : fallback;
}

function inferCommunicationStatus(row: ConversationRecord, ordered: MessageRecord[]): Contribution {
  const resumeEvents=[];
  for (const m of ordered) {
    const label=isSystem(m) && resumeLabel(m.text);
    if (label) resumeEvents.push({status:'resume_event',label,observedAt:messageTime(m),evidence:'系统消息：'+label,priority:3});
    else {const unknown=!isSystemResumeRequest(m)&&unrecognizedResumeNotice(m);if(unknown)resumeEvents.push({status:'unknown',label:'未知',observedAt:messageTime(m),evidence:'未识别的简历系统提示：'+unknown.slice(0,300),priority:3});}
  }
  if(resumeEvents.length){
    const first=resumeEvents[0],different=(e: Contribution)=>e.status!==first.status||e.label!==first.label||e.status==='unknown'&&e.evidence!==first.evidence;
    if(resumeEvents.some(e=>!e.observedAt&&different(e))||!first.observedAt&&resumeEvents.some(different))return {status:'unknown',label:'未知',observedAt:first.observedAt,evidence:'多条不同简历提示存在缺失时间，无法确定最新一条',priority:3};
    if(resumeEvents.some(e=>e!==first&&e.observedAt===first.observedAt&&different(e)))return {status:'unknown',label:'未知',observedAt:first.observedAt,evidence:'多条不同简历提示时间相同，无法确定最新一条',priority:3};
    return first;
  }
  for (const m of ordered) {
    if (isRequest(m)||isSystemResumeRequest(m)) return {status:'resume_requested',label:'对方请求附件简历',observedAt:messageTime(m),evidence:'对方消息：'+(String(m.text || '').trim() || '附件简历请求卡片'),priority:2};
  }
  const latest=ordered.find(m=>isHuman(m) && (m.direction === 'in' || m.direction === 'out') && (String(m.text || '').trim() || m.bodyType != null));
  const preview=String(row.lastText || '').trim(), listTime=Number(row.lastMessageAt)||0;
  if(latest && listTime>messageTime(latest) && preview && !isWithdrawn(preview)){
    if(resumeLabel(preview))return {status:'unknown',label:'未知',observedAt:listTime,evidence:'列表中有较新的疑似简历提示，但对应系统消息尚未采集',priority:0};
    if(typeof row.lastIsSelf!=='boolean')return {status:'unknown',label:'未知',observedAt:listTime,evidence:'列表中有较新的消息，但发送方向未知',priority:0};
    const self=!row.lastIsSelf;
    return {status:self?'awaiting_self':'awaiting_boss',label:self?'待自己回复':'待Boss回复',observedAt:listTime,evidence:'会话列表有较新的消息：'+preview,priority:1};
  }
  if (latest) {
    const self=latest.direction === 'in';
    return {status:self?'awaiting_self':'awaiting_boss',label:self?'待自己回复':'待Boss回复',observedAt:messageTime(latest),evidence:'最近沟通消息：'+(String(latest.text || '').trim() || '消息卡片'),priority:1};
  }
  const onlySystemAtEnd=ordered.length>0 && ordered.every(m=>!isHuman(m)) && (!Number(row.lastMessageAt) || Number(row.lastMessageAt)<=messageTime(ordered[0]));
  if (!onlySystemAtEnd && typeof row.lastIsSelf === 'boolean' && String(row.lastText || '').trim() && !/(?:简历.{0,20}(?:已发送|已查看|请求已发送)|(?:已发送|已查看).{0,20}简历)/.test(row.lastText || '')) {
    const self=!row.lastIsSelf;
    return {status:self?'awaiting_self':'awaiting_boss',label:self?'待自己回复':'待Boss回复',observedAt:messageTime({time:row.lastMessageAt ?? row.time}),evidence:'会话列表最近消息：'+String(row.lastText).trim(),priority:1};
  }
  return {status:'unknown',label:'未知',observedAt:0,evidence:'缺少足够状态证据',priority:0};
}
// Incoming observations replace the same source, including a lower or unknown status.
export function mergeAutoContribution(previous: Contributions={}, incoming: Contributions={}, verifiedOnly=false): Contributions {
  const result: Contributions={};
  for(const source of (verifiedOnly?['verified']:['verified','unverified']) as (keyof Contributions)[]){
    const before=previous?.[source], next=incoming?.[source];
    if(next || before) result[source]=next || before;
  }
  return result;
}
export function mergeJob(previous: JobRecord | null | undefined, incoming: JobRecord): JobRecord {
  const result = {...previous,...incoming};
  if(result.autoContributions){
    let inferred: Contribution={status:'unknown',label:'未知',observedAt:0,evidence:'缺少足够状态证据',priority:0};
    const candidates=[];
    for (const contribution of Object.values(result.autoContributions)) {
      const messages = [contribution?.verified, contribution?.unverified].filter((value): value is Contribution => !!value);
      const closedAt = Math.max(-Infinity, ...messages.map(value => value.interviewClosedAt ?? -Infinity));
      candidates.push(...messages.filter(value => value.status !== 'interviewing' || timeOf(value) > closedAt));
    }
    for(const candidate of candidates)if(priorityOf(candidate)>priorityOf(inferred) || priorityOf(candidate)===priorityOf(inferred) && timeOf(candidate)>timeOf(inferred))inferred=candidate;
    if(priorityOf(inferred)===3){
      const different=(c: Contribution)=>c.status!==inferred.status||c.label!==inferred.label||c.status==='unknown'&&c.evidence!==inferred.evidence;
      const peers=candidates.filter(c=>priorityOf(c)===3&&different(c));
      if(peers.some(c=>!timeOf(c))||!timeOf(inferred)&&peers.length)inferred={status:'unknown',label:'未知',observedAt:timeOf(inferred),evidence:'不同联系人的简历提示存在缺失时间，无法确定最新一条',priority:3};
      else if(peers.some(c=>timeOf(c)===timeOf(inferred)))inferred={status:'unknown',label:'未知',observedAt:timeOf(inferred),evidence:'不同联系人的简历提示时间相同，无法确定最新一条',priority:3};
    }
    result.autoStatus=inferred.status;result.evidence=inferred.evidence;
    result.autoLabel=inferred.label;result.observedAt=inferred.observedAt;result.priority=priorityOf(inferred);
  }
  result.manualStatus=previous?.manualStatus || incoming?.manualStatus || null;
  result.manual=!!result.manualStatus;
  result.status=result.manualStatus || result.autoStatus || 'unknown';
  result.conversationIds=[...new Set([...(previous?.conversationIds||[]),...(incoming.conversationIds||[])])];
  return result;
}
