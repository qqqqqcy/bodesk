import type {ExternalRecord, Contributions, JobRecord, TimedHumanMessagePreview} from './types.ts';
type Change = [string, 'put' | 'delete', any];

import {inferStatus, isChatMessage, isWithdrawn, mergeAutoContribution, mergeJob, validStatus} from './core.ts';
import {registerBuildReload} from './build-reload.ts';
import {normalizeStatus} from './status.ts';
import {syncInterval, syncIntervalSeconds, validSyncInterval} from './sync-interval.ts';
const DB_NAME='boss-local-helper', DB_VERSION=2, STATUS_SCHEMA=6;
const SITE_ORIGINS=['https://www.zhipin.com','http://127.0.0.1:4173','http://localhost:4173'];
const siteOrigin=(value?: string)=>{try{const url=new URL(value || '');return SITE_ORIGINS.includes(url.origin)?url.origin:null;}catch{return null;}};
const sourceGroup=(value?: string)=>{const origin=siteOrigin(value);return !origin?null:origin===SITE_ORIGINS[0]?'real':'mock';};
const jobOrigin=(value: string | undefined,fallback: string | null)=>{try{const url=new URL(value || '');return siteOrigin(value)&&url.pathname.startsWith('/job_detail/')?url.origin:fallback;}catch{return fallback;}};
const stores=['companies','jobs','conversations','messages','events','meta'];
const dbPromise=new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=()=>{for(const s of stores)if(!req.result.objectStoreNames.contains(s))req.result.createObjectStore(s,{keyPath:'id'});const messages=req.transaction!.objectStore('messages');if(!messages.indexNames.contains('conversationId'))messages.createIndex('conversationId','conversationId');};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
function op(store: string, method: 'getAll', value?: IDBValidKey): Promise<ExternalRecord[]>;
function op(store: string, method: 'get', value: IDBValidKey): Promise<ExternalRecord | undefined>;
function op(store: string, method: 'put' | 'delete', value: any): Promise<unknown>;
async function op(store: string, method: 'get' | 'getAll' | 'put' | 'delete', value?: any) {const db=await dbPromise;return new Promise((resolve,reject)=>{const tx=db.transaction(store,method==='get'||method==='getAll'?'readonly':'readwrite');let result: unknown;const req=tx.objectStore(store)[method](value);req.onsuccess=()=>{result=req.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('数据库写入中断'));});}
async function conversationMessages(id: string): Promise<ExternalRecord[]>{const db=await dbPromise;return new Promise((resolve,reject)=>{const tx=db.transaction('messages','readonly');const req=tx.objectStore('messages').index('conversationId').getAll(id);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function commit(changes: Change[]){const db=await dbPromise;return new Promise<void>((resolve,reject)=>{const tx=db.transaction(['companies','jobs','conversations','messages','events'],'readwrite');try{for(const [store,method,value] of changes)tx.objectStore(store)[method](value);}catch(error: any){tx.abort();reject(error);return;}tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||new Error('数据库写入失败'));tx.onabort=()=>reject(tx.error||new Error('数据库写入中断'));});}
let queue: Promise<unknown>=Promise.resolve();
function serialize<Result>(fn: () => Result | Promise<Result>){const run=queue.then(fn);queue=run.catch(()=>{});return run;}
const key=(a: string,id: string)=>`${a}:${id}`;
const earliest=(...values: unknown[])=>values.reduce<number>((min,value)=>typeof value==='number'&&Number.isFinite(value)&&value>0&&(!min||value<min)?value:min,0);
const companyKey=(account: string,name: string)=>key(account,'company:'+name.normalize('NFKC').trim().toLowerCase());
const validJobId=(account: string,id: unknown)=>typeof id==='string'&&id.length<=200&&id.startsWith(key(account,'job:'))&&!!id.slice(key(account,'job:').length).trim();
async function deleteJobs(account: string,jobs: ExternalRecord[],companyId?: string): Promise<Change[]> {
  const ids=new Set(jobs.map(job=>job.id));
  const tokens=new Set(jobs.map(job=>job.id.slice(key(account,'job:').length)));
  const [conversations,events]=await Promise.all([op('conversations','getAll'),op('events','getAll')]);
  const changes: Change[]=jobs.map(job=>['jobs','put',{id:job.id,account,deleted:true,autoSchemaVersion:STATUS_SCHEMA,deletedAt:Date.now(),...(companyId?{companyId}:{})}]);
  for(const conversation of conversations){
    if(conversation.account!==account)continue;
    const clearCompany=!!companyId&&conversation.companyId===companyId;
    const clearJob=tokens.has(conversation.jobId);
    if(clearCompany||clearJob)changes.push(['conversations','put',{...conversation,...(clearCompany?{companyId:''}:{}),...(clearJob?{jobId:'',jobTitle:''}:{})}]);
  }
  for(const event of events)if(event.account===account&&ids.has(event.jobId))changes.push(['events','delete',event.id]);
  return changes;
}
function validateNote(note: unknown){if(typeof note!=='string'||note.length>10000)throw new Error('备注需为不超过 10000 字的文本');}
async function noteCompany(account: string,id: string,name?: string): Promise<ExternalRecord>{
  if(typeof id!=='string'||!id.startsWith(key(account,'company:')))throw new Error('无效公司 ID');
  if(name!==undefined&&(typeof name!=='string'||!name.normalize('NFKC').trim()||name.length>180))throw new Error('无效公司名称');
  const existing=await op('companies','get',id);
  if(existing){if(existing.account!==account||existing.deleted)throw new Error('找不到当前账号的公司');return existing;}
  if(name===undefined||id!==companyKey(account,name))throw new Error('公司 ID 与名称不匹配');
  return {id,account,name:name.trim()};
}
async function saveJob(message: ExternalRecord,origin?: string | null){
  if(typeof message.account!=='string'||!message.account)throw new Error('请选择账号');
  const account=await resolveAccount(message.account);
  if(!validJobId(account,message.jobId))throw new Error('无效 JD ID');
  const hasStatus=Object.hasOwn(message,'status'),hasNote=Object.hasOwn(message,'note');
  if(!hasStatus&&!hasNote)throw new Error('请提供状态或备注');
  if(hasNote)validateNote(message.note);
  const hasExpectedNote=Object.hasOwn(message,'expectedNote'),hasExpectedStatus=Object.hasOwn(message,'expectedManualStatus');
  if(hasExpectedNote)validateNote(message.expectedNote);
  if(hasExpectedStatus&&message.expectedManualStatus!==null&&(typeof message.expectedManualStatus!=='string'||!validStatus(message.expectedManualStatus)))throw new Error('无效的预期人工状态');
  if(hasStatus&&(typeof message.status!=='string'||message.status!=='auto'&&!validStatus(message.status)))throw new Error('无效状态');
  await ensureStatusSchema(account);
  let job=await op('jobs','get',message.jobId),company;
  if(job&&job.account!==account)throw new Error('找不到当前账号的 JD');
  if(job?.deleted)throw new Error('该职位已删除，不能继续修改');
  if(hasExpectedNote&&(job?.note??'')!==message.expectedNote)throw new Error('备注冲突：内容已更改，请刷新后重试');
  if(hasExpectedStatus&&(job?.manualStatus??null)!==message.expectedManualStatus)throw new Error('状态冲突：人工状态已更改，请刷新后重试');
  if(!job){
    const context=message.context;
    if(!context||typeof context!=='object'||Array.isArray(context)||typeof context.title!=='string'||!context.title.trim()||context.title.length>200)throw new Error('缺少有效的职位上下文');
    company=await noteCompany(account,context.companyId,context.companyName);
    const jobSite=origin||(await accountSource(account)==='mock'?SITE_ORIGINS[1]:SITE_ORIGINS[0]);
    job={id:message.jobId,account,companyId:company.id,title:context.title.trim(),url:jobSite+'/job_detail/'+encodeURIComponent(message.jobId.slice(key(account,'job:').length))+'.html',autoContributions:{},autoSchemaVersion:STATUS_SCHEMA,autoStatus:'unknown',autoLabel:'未知',status:'unknown',manual:false,manualStatus:null,conversationIds:[],firstConversationAt:0};
  }else if(hasStatus&&message.status==='auto'){
    await ensureStatusSchema(account);
    job=await op('jobs','get',message.jobId);
  }
  const next: ExternalRecord={...job,updatedAt:Date.now()};
  if(origin&&message.context?.preview===true)next.tracked=true;
  if(hasNote)next.note=message.note;
  if(hasStatus){next.manualStatus=message.status==='auto'?null:message.status;next.manual=!!next.manualStatus;next.status=next.manualStatus||next.autoStatus||'unknown';}
  const changes: Change[]=[['jobs','put',next]];
  if(company)changes.unshift(['companies','put',company]);
  if(hasStatus&&(job?.manualStatus??null)!==next.manualStatus)changes.push(['events','put',{id:key(account,crypto.randomUUID()),account,jobId:next.id,status:next.status,source:'manual',evidence:message.status==='auto'?'恢复自动状态':'用户修订',time:next.updatedAt}]);
  await commit(changes);
  return {ok:true};
}
async function meta(id: string,fallback: unknown){return (await op('meta','get',id))?.value??fallback;}
async function setMeta(id: string,value: unknown){await op('meta','put',{id,value});}
async function currentAccount(){return meta('activeAccount',null);}
async function accountSource(account: string,expected?: string | null){
  let group=await meta(key(account,'sourceGroup'),null);
  if(!group){
    const groups=new Set((await op('jobs','getAll')).filter(j=>j.account===account&&jobOrigin(j.url,null)).map(j=>sourceGroup(j.url)));
    if(groups.size!==1)throw new Error('无法确定历史账号来源，请重新识别账号');
    group=[...groups][0];
    if(expected&&group!==expected)throw new Error('账号与页面来源不匹配');
    await setMeta(key(account,'sourceGroup'),group);
  }
  if(!['real','mock'].includes(group)||expected&&group!==expected)throw new Error('账号与页面来源不匹配');
  return group;
}
async function registerAccount(account: string,group: string){
  const accounts=await meta('accounts',[]),active=await currentAccount();
  let known=accounts.includes(account)||active===account;
  if(!known)for(const store of stores.filter(s=>s!=='meta'))if((await op(store,'getAll')).some(record=>record.account===account)){known=true;break;}
  if(known)await accountSource(account,group);
  else await setMeta(key(account,'sourceGroup'),group);
  if(active&&!accounts.includes(active))accounts.push(active);if(!accounts.includes(account))accounts.push(account);await setMeta('accounts',accounts);if(!active)await setMeta('activeAccount',account);
}
async function requireSiteAccount(account: string,sender: chrome.runtime.MessageSender){
  if(typeof account!=='string'||!account)throw new Error('页面账号尚未识别，请稍后重试');
  await resolveAccount(account);
  await accountSource(account,sourceGroup(sender.url));
  let bound=tabAccounts.get(sender.tab!.id);
  if(!bound){const saved=await meta('tab-binding:'+sender.tab!.id,null);if(saved?.group===sourceGroup(sender.url)){bound=saved.account;tabAccounts.set(sender.tab!.id,bound!);}}
  if(bound!==account)throw new Error('页面账号尚未识别或不匹配，请刷新页面');
}
async function resolveAccount(requested?: string | null): Promise<string>{const accounts=await meta('accounts',[]), account=requested===undefined?await currentAccount():requested;if(!accounts.includes(account))throw new Error('未知账号');return account;}
async function addEvent(account: string,jobId: string,status: string,source: string,evidence: string){await op('events','put',{id:key(account,crypto.randomUUID()),account,jobId,status,source,evidence,time:Date.now()});}
const tabAccounts=new Map<number | undefined, string>();
const RUN_LEASE_MS=90000;
async function syncTask(account: string){
  let task=await meta(key(account,'sync'),{});
  if(task.running&&(!task.runId||!Number.isInteger(task.tabId)||Date.now()-(Number(task.updatedAt)||0)>RUN_LEASE_MS)){
    task={...task,running:false,complete:false,interrupted:true,message:'同步已中断，可重试',updatedAt:Date.now()};
    await setMeta(key(account,'sync'),task);
  }
  return task;
}
if (chrome.alarms) registerBuildReload(reload => serialize(async () => {
  for (const account of await meta('accounts', [])) {
    if ((await syncTask(account)).running) return;
  }
  await reload();
}));
async function requireRun(d: ExternalRecord,sender: chrome.runtime.MessageSender){
  const task=await syncTask(d.account);
  if(!task.running||!d.runId||task.runId!==d.runId||task.tabId!==sender.tab!.id)throw new Error('同步任务已过期或不属于此标签页');
  return task;
}
function invalidateTab(id: number){
  tabAccounts.delete(id);
  serialize(async()=>{
    await op('meta','delete','tab-binding:'+id);
    for(const account of await meta('accounts',[])){
      const task=await syncTask(account);
      if(task.running&&task.tabId===id)await setMeta(key(account,'sync'),{...task,running:false,complete:false,interrupted:true,message:'聊天页已关闭或重新加载，同步已中断',updatedAt:Date.now()});
    }
  }).catch(()=>{});
}
chrome.tabs.onRemoved.addListener(invalidateTab);
chrome.tabs.onUpdated.addListener((id,change)=>{if(change.url||change.status==='loading')invalidateTab(id);});
function validate(value: unknown,depth=0){if(depth>8)throw new Error('数据结构过深');if(typeof value==='string'&&value.length>6000)throw new Error('字符串过长');if(typeof value==='number'&&!Number.isFinite(value))throw new Error('无效数字');if(value&&typeof value==='object'){if(Array.isArray(value)){if(value.length>10000)throw new Error('数据过多');for(const item of value)validate(item,depth+1);}else{const entries=Object.entries(value);if(entries.length>100)throw new Error('字段过多');for(const [name,item] of entries){if(name.length>100||name==='__proto__'||name==='constructor'||name==='prototype')throw new Error('无效字段');if((name==='id'||name==='jobId'||name==='selectedId'||name==='conversationId')&&item!=null&&(typeof item!=='string'||item.length>200))throw new Error('无效 ID');validate(item,depth+1);}}}}
function validateIngest(d: ExternalRecord){if(!d||typeof d!=='object'||Array.isArray(d)||typeof d.account!=='string'||!/^[a-f0-9]{24}$/.test(d.account))throw new Error('未识别账号');validate(d);if(d.type==='SNAPSHOT'&&(!Array.isArray(d.rows)||d.rows.length>10000||d.liveMessages!==undefined&&(!Array.isArray(d.liveMessages)||d.liveMessages.length>2000)))throw new Error('无效会话列表');if(d.type==='CONVERSATION'&&(!d.row||typeof d.row!=='object'||Array.isArray(d.row)||!d.row.id||!Array.isArray(d.messages||[])||(d.messages||[]).length>2000))throw new Error('无效会话数据');if(d.type==='SNAPSHOT'&&d.rows.some((row: ExternalRecord)=>!row||typeof row!=='object'||Array.isArray(row)||!row.id))throw new Error('无效会话数据');if(d.type==='CONVERSATION'&&((d.detail!=null&&(typeof d.detail!=='object'||Array.isArray(d.detail)))||(d.history!=null&&(typeof d.history!=='object'||Array.isArray(d.history)))||(d.messages||[]).some((m: ExternalRecord)=>!m||typeof m!=='object'||Array.isArray(m))))throw new Error('无效会话数据');for(const row of d.type==='SNAPSHOT'?d.rows:d.type==='CONVERSATION'?[d.row]:[]){for(const field of ['name','companyName','jobId','jobTitle','lastText'])if(row[field]!=null&&typeof row[field]!=='string')throw new Error('无效会话字段');}for(const field of ['companyName','jobId','title','salary','location','experience','degree'])if(d.detail?.[field]!=null&&typeof d.detail[field]!=='string')throw new Error('无效职位字段');if(d.type==='SYNC_PROGRESS'&&(!d.sync||typeof d.sync!=='object'||Array.isArray(d.sync)||typeof d.sync.running!=='boolean'))throw new Error('无效同步进度');}
function validateFavorites(rows: ExternalRecord[]){
  if(!Array.isArray(rows)||rows.length>10000)throw new Error('无效收藏列表');
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.jobId!=='string'||!/^[a-zA-Z0-9_-]{1,150}$/.test(row.jobId)||typeof row.favorite!=='boolean')throw new Error('无效收藏职位');
    for(const [field,max] of [['companyName',180],['title',200],['salary',100],['location',100],['experience',100],['degree',100]] as const)if(row[field]!=null&&(typeof row[field]!=='string'||row[field].length>max))throw new Error('无效收藏字段');
    if(row.favorite&&(!row.companyName?.trim()||!row.title?.trim()))throw new Error('收藏职位缺少公司或标题');
  }
}
async function ingestFavorites(account: string,rows: ExternalRecord[],origin: string){
  const changes: Change[]=[];
  for(const row of new Map(rows.map(row=>[row.jobId,row])).values()){
    const id=key(account,'job:'+row.jobId),previous=await op('jobs','get',id);
    if(previous?.deleted)continue;
    if(!row.favorite&&previous?.favorite!==true)continue;
    const companyId=previous?.companyId||(row.favorite?companyKey(account,row.companyName):null);
    const company=companyId?await op('companies','get',companyId):null;
    if(company?.deleted)continue;
    if(row.favorite&&!company)changes.push(['companies','put',{id:companyId,account,name:row.companyName.trim(),updatedAt:Date.now()}]);
    const next: ExternalRecord=previous?{...previous}:{id,account,companyId,title:row.title.trim(),status:'unknown',autoStatus:'unknown',manual:false,manualStatus:null,autoContributions:{},autoSchemaVersion:STATUS_SCHEMA,conversationIds:[],firstConversationAt:0};
    next.favorite=row.favorite;
    next.url=jobOrigin(previous?.url,origin)+'/job_detail/'+encodeURIComponent(row.jobId)+'.html';
    for(const field of ['salary','location','experience','degree'])if(!next[field]&&row[field])next[field]=row[field];
    if(!previous||Object.entries(next).some(([field,value])=>!Object.is(previous[field],value)))changes.push(['jobs','put',{...next,updatedAt:Date.now()}]);
  }
  if(changes.length){await commit(changes);chrome.runtime.sendMessage?.({type:'FAVORITES_CHANGED',account})?.catch(()=>{});}
}
async function ingestBatch(account: string,items: ExternalRecord[],selectedId?: string,origin='https://www.zhipin.com'){
  const changes: Change[]=[], cache=new Map();let summary: ExternalRecord | null=null,legacyConversations: ExternalRecord[] | undefined;
  async function get(store: string,id: string): Promise<ExternalRecord | undefined>{const k=store+'\0'+id;if(!cache.has(k))cache.set(k,await op(store,'get',id));return cache.get(k);}
  function put(store: string,value: ExternalRecord){cache.set(store+'\0'+value.id,value);changes.push([store,'put',value]);}
  function remove(store: string,id: string){cache.set(store+'\0'+id,undefined);changes.push([store,'delete',id]);}
  function contribution(row: ExternalRecord,messages: ExternalRecord[],jobToken: string,multiple: boolean){
    const verified=inferStatus({},messages.filter(m=>m.jobId===jobToken));
    if(multiple)return {verified};
    const unverified=inferStatus(row,messages.filter(m=>!m.jobId));
    unverified.evidence+='；联系人当前JD关联，历史归属未独立验证';
    return {verified,unverified};
  }
  async function migrateContributions(job: ExternalRecord | null | undefined){
    if(!job||job.autoContributions&&job.autoSchemaVersion===STATUS_SCHEMA)return job;
    legacyConversations??=await op('conversations','getAll');
    // Older records may only retain the last contact; include stored backlinks before attributing anything.
    const related=legacyConversations.filter(c=>c.account===account&&c.jobIds?.includes(job.id)).map(c=>c.id);
    const ids=[...new Set([...(job.conversationIds||[]),job.conversationId,...related].filter(Boolean))],autoContributions: Record<string, Contributions>={};
    const jobToken=job.id.slice(key(account,'job:').length);
    for(const id of ids){
      const conversation=await get('conversations',id);
      if(!conversation||conversation.account!==account||!conversation.jobIds?.includes(job.id))continue;
      const multiple=conversation.jobIds.length>1;
      let value=contribution(conversation,await conversationMessages(id),jobToken,multiple);
      // Recompute from stored messages; old automatic stages used a different rule.
      autoContributions[id]=value;
    }
    return mergeJob(job,{autoContributions,autoSchemaVersion:STATUS_SCHEMA,conversationIds:ids});
  }
  for(const {row,detail={},messages=[],history} of items){
    const cid=key(account,'conversation:'+row.id),prev=await get('conversations',cid);
    const jobToken=detail.jobId||row.jobId, jid=jobToken?key(account,'job:'+jobToken):null;
    const storedPrevious=jid?await get('jobs',jid):null;
    const previous=storedPrevious?.deleted?null:await migrateContributions(storedPrevious);
    const companyName=String(detail.companyName||(!previous?.detailCompany&&row.companyName)||'待识别公司').slice(0,180);
    const companyId=storedPrevious?.deleted&&storedPrevious.companyId?storedPrevious.companyId:detail.companyName||!previous?.companyId?companyKey(account,companyName):previous.companyId;
    const company=await get('companies',companyId);
    if(!company?.deleted&&(!previous?.companyId||detail.companyName||!previous?.detailCompany))put('companies',{...company,id:companyId,account,name:companyName,updatedAt:Date.now()});
    const saved=new Map((await conversationMessages(cid)).map(m=>[m.id,m]));
    for(const m of messages){if(!m.id)continue;const id=key(account,'message:'+row.id+':'+m.id),old=saved.get(id);const item={...old,...m,id,messageId:m.id,account,conversationId:cid};if(m.isSystem==null&&typeof old?.isSystem==='boolean')item.isSystem=old.isSystem;if((!m.text)&&old?.text)item.text=old.text;if(m.direction==='unknown'&&old?.direction){item.direction=old.direction;item.directionBasis=old.directionBasis||'legacy';}if(!m.time&&old?.time)item.time=old.time;if(m.templateId==null&&old?.templateId!=null)item.templateId=old.templateId;if(old?.status===2||old?.status===1&&m.status!==2)item.status=old.status;saved.set(item.id,item);put('messages',item);}
    const firstMessageAt=earliest(prev?.firstMessageAt,...[...saved.values()].map(m=>m.time));
    const pendingId=key(account,'job:pending:'+row.id);
    const jobIds=[...new Set([...(prev?.jobIds||[]).filter((id: string)=>id!==pendingId||id===jid),...(jid?[jid]:[])])];
    let next;
    if(jid&&!storedPrevious?.deleted&&!company?.deleted){
      const multiple=jobIds.length>1;
      const observations=[...saved.values()];
      if(multiple)for(const oldId of jobIds.filter(id=>id!==jid)){
        const old=await get('jobs',oldId);
        if(!old||old.deleted)continue;
        const migrated=(await migrateContributions(old))!;
        const value=mergeAutoContribution(migrated.autoContributions[cid],contribution({},observations,oldId.slice(key(account,'job:').length),true),true);
        const updated=mergeJob(migrated,{autoContributions:{...migrated.autoContributions,[cid]:value},firstConversationAt:earliest(migrated.firstConversationAt,firstMessageAt),updatedAt:Date.now()});
        put('jobs',updated);
        if(old.status!==updated.status)put('events',{id:key(account,crypto.randomUUID()),account,jobId:old.id,status:updated.status,source:'automatic',evidence:updated.evidence,time:Date.now()});
      }
      const value=mergeAutoContribution(previous?.autoContributions?.[cid],contribution(row,observations,jobToken,multiple),multiple);
      next=mergeJob(previous,{id:jid,account,companyId,title:detail.title||(!previous?.detailTitle&&row.jobTitle)||previous?.title||'待识别 JD',detailTitle:!!detail.title||!!previous?.detailTitle,detailCompany:!!detail.companyName||!!previous?.detailCompany,url:jobOrigin(previous?.url,origin)+'/job_detail/'+encodeURIComponent(jobToken)+'.html',salary:detail.salary||previous?.salary||'',location:detail.location||previous?.location||'',experience:detail.experience||previous?.experience||'',degree:detail.degree||previous?.degree||'',autoContributions:{...previous?.autoContributions,[cid]:value},autoSchemaVersion:STATUS_SCHEMA,conversationId:cid,conversationIds:[cid],firstConversationAt:earliest(previous?.firstConversationAt,firstMessageAt),updatedAt:Date.now()});
      const pending=await get('jobs',pendingId);if(pending&&pendingId!==jid){
        next.firstConversationAt=earliest(next.firstConversationAt,pending.firstConversationAt);
        const conflicts=[...(Array.isArray(next.noteConflicts)?next.noteConflicts:[])];
        const addConflict=(entry: ExternalRecord)=>{if(!conflicts.some(x=>x.sourceId===entry.sourceId&&x.text===entry.text))conflicts.push(entry);};
        if(Array.isArray(pending.noteConflicts))for(const entry of pending.noteConflicts)addConflict(entry);
        if(pending.note){if(!next.note)next.note=pending.note;else if(next.note!==pending.note)addConflict({sourceId:pendingId,text:pending.note});}
        if(conflicts.length)next.noteConflicts=conflicts;
        if(!next.manualStatus&&pending.manualStatus){next.manualStatus=pending.manualStatus;next.manual=true;next.status=pending.manualStatus;}
        remove('jobs',pendingId);
      }
      put('jobs',next);
      if(storedPrevious?.status!==next.status)put('events',{id:key(account,crypto.randomUUID()),account,jobId:jid,status:next.status,source:'automatic',evidence:next.evidence,time:Date.now()});
    }
    // Historical records can retain associations on either side, even when this page has no JD.
    const backlinks=(await op('jobs','getAll')).filter(j=>j.account===account&&(j.conversationId===cid||j.conversationIds?.includes(cid))).map(j=>j.id);
    for(const oldId of new Set([...(prev?.jobIds||[]),...backlinks])){
      if(oldId===jid||oldId===pendingId&&jid)continue;
      const old=await get('jobs',oldId);
      if(old&&!old.deleted)put('jobs',{...old,firstConversationAt:earliest(old.firstConversationAt,firstMessageAt)});
    }
    let storedHistory=prev?.history?{...prev.history}:undefined;
    if(history?.runId){
      const runs={...storedHistory?.syncRuns};
      const previousRun=runs[history.runId];
      if(history.pages!==(previousRun?.pages||0)+1||history.continuousFromStart!==true)throw new Error('同步页序不连续');
      const proof={runId:history.runId,pages:history.pages,serverReportsEnd:history.serverReportsEnd===true,continuousFromStart:true,count:history.count,updatedAt:Date.now()};
      runs[history.runId]=proof;
      storedHistory={...storedHistory,...proof,syncRuns:runs};
    }else if(history){
      storedHistory={...storedHistory,observedEnd:history.observedEnd===true,observedAt:Date.now()};
    }
    if(storedHistory)delete storedHistory.complete;
    const storedRow=storedPrevious?.deleted||company?.deleted?{...row,jobId:'',jobTitle:''}:row;
    put('conversations',{...prev,...storedRow,id:cid,account,companyId:company?.deleted?'':jid?companyId:(prev?.companyId||companyId),jobIds:jid&&!company?.deleted?jobIds:(prev?.jobIds||[]),firstMessageAt,history:storedHistory,updatedAt:Date.now()});
    if(row.id===selectedId||items.length===1)summary={companyName:detail.companyName||((await get('companies',companyId))?.name)||companyName,jobTitle:next?.title||row.jobTitle||'待识别 JD',status:next?.status||'unknown',manual:!!next?.manual};
  }
  await commit(changes);return summary;
}
// Backfill from local messages and both directions of the historical association.
async function ensureConversationOrder(account: string){
  if(await meta(key(account,'conversationOrderVersion'),0)===1)return;
  const jobs=(await op('jobs','getAll')).filter(j=>j.account===account);
  const conversations=(await op('conversations','getAll')).filter(c=>c.account===account);
  const messages=(await op('messages','getAll')).filter(m=>m.account===account);
  const times=new Map();
  for(const m of messages)times.set(m.conversationId,earliest(times.get(m.conversationId),m.time));
  const changes: Change[]=[],byId=new Map();
  for(const c of conversations){
    const time=earliest(c.firstMessageAt,times.get(c.id));byId.set(c.id,time);
    changes.push(['conversations','put',{...c,firstMessageAt:time}]);
  }
  for(const job of jobs){
    if(job.deleted)continue;
    const ids=new Set([...(job.conversationIds||[]),job.conversationId,...conversations.filter(c=>c.jobIds?.includes(job.id)).map(c=>c.id)]);
    changes.push(['jobs','put',{...job,firstConversationAt:earliest(job.firstConversationAt,...[...ids].map(id=>byId.get(id)))}]);
  }
  if(changes.length)await commit(changes);
  await setMeta(key(account,'conversationOrderVersion'),1);
}
// Normalize interview stages independently of automatic status schema and current conversations.
async function migrateInterviews(account: string){
  const normalize=(value: unknown)=>typeof value==='string'&&/^interview_[1-9]\d*$/.test(value)?'interviewing':value;
  const jobs=(await op('jobs','getAll')).filter(j=>j.account===account),changes: Change[]=[];
  for(const job of jobs){
    if(job.deleted)continue;
    const manualStatus=normalize(job.manualStatus)||(job.manual&&normalize(job.status)==='interviewing'?'interviewing':job.manualStatus);
    const autoStatus=normalize(job.autoStatus),status=manualStatus||normalize(job.status);
    if(manualStatus!==job.manualStatus||autoStatus!==job.autoStatus||status!==job.status)changes.push(['jobs','put',{...job,manualStatus,autoStatus,status,...(manualStatus?{manual:true}:{})}]);
  }
  if(changes.length)await commit(changes);
  const settings=await op('meta','get',key(account,'settings'));
  if(settings?.value&&Object.hasOwn(settings.value,'interviewRounds')){const {interviewRounds,...rest}=settings.value;await setMeta(settings.id,rest);}
}
// Recompute old automatic states from local messages before any view or manual reset.
async function ensureStatusSchema(account: string){
  if(!account)return;
  await migrateInterviews(account);
  const old=(await op('jobs','getAll')).filter(j=>j.account===account&&j.autoSchemaVersion!==STATUS_SCHEMA);
  if(!old.length)return;
  const prefix=key(account,'conversation:'),jobPrefix=key(account,'job:');
  const conversations=(await op('conversations','getAll')).filter(c=>c.account===account&&c.id.startsWith(prefix));
  const items=conversations.map(c=>{const only=c.jobIds?.length===1&&c.jobIds[0]?.startsWith(jobPrefix)?c.jobIds[0].slice(jobPrefix.length):'';return{row:{...c,id:c.id.slice(prefix.length),jobId:c.jobId||only}};}).filter(x=>x.row.id&&x.row.jobId);
  for(let i=0;i<items.length;i+=50)await ingestBatch(account,items.slice(i,i+50));
  const remaining=(await op('jobs','getAll')).filter(j=>j.account===account&&j.autoSchemaVersion!==STATUS_SCHEMA);
  if(remaining.length)await commit(remaining.map(j=>['jobs','put',{...j,autoContributions:{},autoSchemaVersion:STATUS_SCHEMA,autoStatus:'unknown',autoLabel:'未知',evidence:'旧记录缺少可关联的会话，无法按新规则确认',status:j.manualStatus||'unknown',manual:!!j.manualStatus}]));
}
function visibleJobs(jobs: ExternalRecord[],conversations: ExternalRecord[]){
  const conversationIds=new Set(conversations.map(conversation=>conversation.id));
  const jobIds=new Set(conversations.flatMap(conversation=>Array.isArray(conversation.jobIds)?conversation.jobIds:[]));
  return jobs.filter(job=>!job.deleted&&(job.tracked===true||job.favorite!==false||jobIds.has(job.id)||conversationIds.has(job.conversationId)||(Array.isArray(job.conversationIds)&&job.conversationIds.some(id=>conversationIds.has(id)))));
}
const messageIdOrder = new Intl.Collator('en', {numeric: true});
const messageReceipt = (status: unknown) => status === 2 ? 'read' : status === 1 ? 'delivered' : undefined;
async function latestJobMessages(account: string, related: JobRecord[], allJobs: ExternalRecord[], conversations: ExternalRecord[], includeListPreview = false) {
  if (!related.length) return new Map<string, TimedHumanMessagePreview>();
  const relevantJobs = new Map(related.map(job => [job.id, job]));
  const associations = new Map<string, Set<string>>(conversations.map(conversation => [conversation.id, new Set(conversation.jobIds || [])]));
  for (const job of allJobs) {
    for (const conversationId of [...(job.conversationIds || []), job.conversationId]) associations.get(conversationId)?.add(job.id);
  }

  const latest = new Map<string, TimedHumanMessagePreview & {messageId: string}>();
  for (const conversation of conversations) {
    const conversationId = conversation.id;
    const jobIds = associations.get(conversationId)!;
    if (![...jobIds].some(jobId => relevantJobs.has(jobId))) continue;
    const soleJob = jobIds.size === 1 ? jobIds.values().next().value : undefined;
    const listJob = key(account, 'job:' + conversation.jobId) === soleJob ? soleJob : undefined;
    const listTime = earliest(conversation.lastMessageAt);
    const listText = typeof conversation.lastText === 'string' ? conversation.lastText.trim() : '';
    const listReceipt = conversation.lastIsSelf === true ? messageReceipt(conversation.lastMsgStatus) : undefined;
    let newestSavedAt = 0;
    for (const message of await conversationMessages(conversationId)) {
      const time = earliest(message.time);
      newestSavedAt = Math.max(newestSavedAt, time);
      const jobId = message.jobId ? key(account, 'job:' + message.jobId) : soleJob;
      if (!jobId || !jobIds.has(jobId) || !relevantJobs.has(jobId) || !isChatMessage(message)) continue;
      const image = message.messageType === 'image' || Number(message.bodyType) === 3;
      const text = (typeof message.text === 'string' ? message.text.trim() : '') || (image ? '[图片]' : '');
      if (!text) continue;
      const messageId = String(message.messageId || message.id);
      const previous = latest.get(jobId);
      if (previous && (time < previous.time || (time === previous.time && messageIdOrder.compare(messageId, previous.messageId) <= 0))) continue;
      const direction = message.direction === 'in' || message.direction === 'out' ? message.direction : 'unknown';
      const matchedReceipt = jobId === listJob && time > 0 && time === listTime && text === listText ? listReceipt : undefined;
      const receipt = direction === 'out' ? (matchedReceipt === 'read' ? matchedReceipt : messageReceipt(message.status) ?? matchedReceipt) : undefined;
      latest.set(jobId, {text, direction, time, messageId, ...(receipt ? {receipt} : {})});
    }
    if (!includeListPreview || !listJob || typeof conversation.lastIsSelf !== 'boolean') continue;
    if (listTime <= Math.max(newestSavedAt, latest.get(listJob)?.time ?? 0) || !listText || isWithdrawn(listText)) continue;
    const inferred = relevantJobs.get(listJob)?.autoContributions?.[conversationId]?.unverified;
    const status = conversation.lastIsSelf ? 'awaiting_boss' : 'awaiting_self';
    if (inferred?.status !== status || inferred.observedAt !== listTime) continue;
    latest.set(listJob, {text: listText, direction: conversation.lastIsSelf ? 'out' : 'in', time: listTime, messageId: '', fromList: true,
      ...(listReceipt ? {receipt: listReceipt} : {})});
  }
  return new Map([...latest].map(([jobId, {messageId, ...preview}]) => [jobId, preview]));
}
async function data(account: string,includeHidden=false){const accounts=await meta('accounts',[]);const result: ExternalRecord={account,accounts,settings:{},sync:await syncTask(account)};for(const s of stores.filter(s=>s!=='meta'&&s!=='messages'))result[s]=(await op(s,'getAll')).filter(x=>x.account===account);result.jobs=result.jobs.filter((job: ExternalRecord)=>!job.deleted);if(!includeHidden)result.jobs=visibleJobs(result.jobs,result.conversations);const referenced=new Set([...result.jobs,...result.conversations].map((x: ExternalRecord)=>x.companyId).filter(Boolean));result.companies=result.companies.filter((x: ExternalRecord)=>!x.deleted&&(referenced.has(x.id)||typeof x.note==='string'&&x.note.length>0));return result;}
function jobsWithStatusTimes(jobs: JobRecord[], events: ExternalRecord[]): JobRecord[] {
  const manualEvents = new Map<string, ExternalRecord>();
  for (const event of events) {
    if (event.source !== 'manual' || typeof event.status !== 'string' || !Number.isFinite(event.time) || event.time <= 0) continue;
    const previous = manualEvents.get(event.jobId);
    if (!previous || event.time > previous.time || event.time === previous.time && event.evidence === '恢复自动状态') {
      manualEvents.set(event.jobId, event);
    }
  }
  return jobs.map(job => {
    const status = job.manualStatus || job.status || job.autoStatus;
    if (job.manual || job.manualStatus) {
      const event = manualEvents.get(job.id);
      const statusAt = typeof status === 'string' && event && event.evidence === '用户修订' && normalizeStatus(event.status) === normalizeStatus(status) ? event.time : undefined;
      return {...job, statusAt};
    }
    const statusAt = status && status !== 'unknown' && status === job.autoStatus ? job.observedAt : undefined;
    const manualEvent = manualEvents.get(job.id);
    const restoredAt = manualEvent?.evidence === '恢复自动状态' ? manualEvent.time : 0;
    const contributions: Contributions[] = Object.values(job.autoContributions ?? {});
    const interviewClosedAt = status === 'interviewing' ? 0 : contributions.reduce((latest, {verified, unverified}) =>
      Math.max(latest, earliest(verified?.interviewClosedAt), earliest(unverified?.interviewClosedAt)), 0);
    const statusActivityAt = Math.max(restoredAt, interviewClosedAt) || undefined;
    return {...job, statusAt, statusActivityAt};
  });
}
async function bossTab(account: string){const tabs=await chrome.tabs.query({url:SITE_ORIGINS.map(origin=>origin+'/web/geek/chat*')});const group=await accountSource(account);for(const tab of tabs){if(!tabAccounts.has(tab.id)&&sourceGroup(tab.url)===group){try{const r=await chrome.tabs.sendMessage(tab.id!,{type:'ACCOUNT_INFO'});if(r?.account===account)tabAccounts.set(tab.id,r.account);}catch{}}}const matching=tabs.filter(t=>tabAccounts.get(t.id)===account&&(!t.url||sourceGroup(t.url)===group));if(!matching.length)throw new Error('没有与该账号匹配的 BOSS 聊天页，请打开并刷新页面');return matching.find(t=>t.active)||matching[matching.length-1];}
function openDashboardTab(windowId: number | undefined, view: 'board' | 'collection', account?: string) {
  const url = new URL(chrome.runtime.getURL('dist/dashboard.html'));
  if (account) url.searchParams.set('account', account);
  if (view === 'board') url.hash = 'board';
  return chrome.tabs.create({url: url.href, ...(Number.isInteger(windowId) ? {windowId} : {})});
}

chrome.action.onClicked.addListener(tab => openDashboardTab(tab?.windowId, 'board', tab?.id === undefined ? undefined : tabAccounts.get(tab.id)));
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  const fromSite=!!sender.tab&&(()=>{const origin=siteOrigin(sender.url);if(!origin)return false;try{const path=new URL(sender.url || '').pathname;return path.startsWith('/web/')||path.startsWith('/job_detail/');}catch{return false;}})();
  const fromUI=sender.url?.startsWith(chrome.runtime.getURL(''));
  (async()=>{
    if(message.type==='INGEST'&&fromSite){return serialize(async()=>{
      const d=message.data;validateIngest(d);
      if(d.type==='FAVORITES')validateFavorites(d.rows);
      if(d.type==='PAGE_CONTEXT'&&Object.hasOwn(d,'favorite'))validateFavorites([d]);
      const task=d.runId||['SYNC_PROGRESS','SYNC_ERROR'].includes(d.type)?await requireRun(d,sender):null;
      if(d.type==='CONVERSATION'&&d.history&&(d.history.runId||d.history.continuousFromStart||d.history.serverReportsEnd||d.history.pages)){
        if(!task||!d.requestId||d.history.runId!==d.runId||!Number.isInteger(d.history.pages)||d.history.pages<1)throw new Error('缺少本次同步保存凭据');
      }
      await registerAccount(d.account,sourceGroup(sender.url)!);
      await migrateInterviews(d.account);
      await ensureConversationOrder(d.account);
      tabAccounts.set(sender.tab!.id,d.account);
      await setMeta('tab-binding:'+sender.tab!.id,{account:d.account,group:sourceGroup(sender.url)});
      if(d.type==='FAVORITES'){await ingestFavorites(d.account,d.rows,siteOrigin(sender.url)!);return {ok:true,count:d.rows.length};}
      if(d.type==='PAGE_CONTEXT'){
        if(typeof d.favorite==='boolean')await ingestFavorites(d.account,[d],siteOrigin(sender.url)!);
        let job=await op('jobs','get',key(d.account,'job:'+d.jobId));
        const pageJobId=new URL(sender.url!).pathname.match(/^\/job_detail\/([a-zA-Z0-9_-]{1,150})\.html$/)?.[1];
        const title=typeof d.title==='string'&&d.title.length<=200?d.title.trim():'';
        if(job&&job.account===d.account&&!job.deleted&&pageJobId&&pageJobId===d.jobId&&title&&title!=='待识别 JD'&&(!job.title?.trim()||job.title==='待识别 JD')){
          job={...job,title,detailTitle:true,updatedAt:Date.now()};
          await op('jobs','put',job);
        }
        const companies=(await op('companies','getAll')).filter(c=>c.account===d.account&&!c.deleted&&c.name===d.companyName);
        const jobs=(await op('jobs','getAll')).filter(j=>j.account===d.account&&!j.deleted&&companies.some(c=>c.id===j.companyId));
        return {ok:true,summary:job?{companyName:d.companyName,jobTitle:job.title,status:job.status,manual:job.manual}:{companyName:d.companyName||'公司待识别',jobTitle:d.title,status:'unknown',manual:false},companyJobCount:jobs.length};
      }
      if(d.type==='SNAPSHOT'){const summary=await ingestBatch(d.account,d.rows.map((row: ExternalRecord)=>({row})),d.selectedId,siteOrigin(sender.url)!);return {ok:true,summary,count:d.rows.length};}
      if(d.type==='CONVERSATION'){
        const summary=await ingestBatch(d.account,[{row:d.row,detail:d.detail||{},messages:d.messages||[],history:d.history}],d.row.id,siteOrigin(sender.url)!);
        if(task)await setMeta(key(d.account,'sync'),{...task,updatedAt:Date.now()});
        return {ok:true,summary};
      }
      if(d.type==='SYNC_PROGRESS'){
        await setMeta(key(d.account,'sync'),{...d.sync,runId:task.runId,tabId:task.tabId,startedAt:task.startedAt,stopping:!!task.stopping,complete:!task.stopping&&!d.sync.running&&d.sync.complete===true,updatedAt:Date.now()});return {ok:true};
      }
      if(d.type==='SYNC_ERROR'){await op('events','put',{id:key(d.account,crypto.randomUUID()),account:d.account,conversationId:d.conversationId,source:'sync_error',evidence:String(d.error).slice(0,250),time:Date.now()});return {ok:true};}
      throw new Error('不支持的观察数据');
    });}
    if(message.type==='WIDGET_GET'&&fromSite)return serialize(async()=>{
      if(typeof message.account!=='string'||!message.account)throw new Error('请选择账号');
      for(const [field,max] of [['jobId',200],['companyName',180],['title',6000]] as const)if(message[field]!=null&&(typeof message[field]!=='string'||message[field].length>max))throw new Error('无效职位字段');
      await requireSiteAccount(message.account,sender);
      const account=message.account,candidate=message.jobId?key(account,'job:'+message.jobId):null,jobId=validJobId(account,candidate)?candidate:null;
      await ensureStatusSchema(account);
      await ensureConversationOrder(account);
      const allJobs=(await op('jobs','getAll')).filter(j=>j.account===account);
      const conversations=(await op('conversations','getAll')).filter(c=>c.account===account);
      const visible=visibleJobs(allJobs,conversations),found=allJobs.find(j=>j.id===jobId),job=visible.find(j=>j.id===jobId);
      const companyId=found?.companyId||(message.companyName?.normalize('NFKC').trim()?companyKey(account,message.companyName):null);
      const company=companyId?await op('companies','get',companyId):null;
      if(company?.deleted)return {ok:true,data:{companyName:message.companyName||'',companyDeleted:true,jobs:[]}};
      const path=new URL(sender.url!).pathname;
      const previewPage=/^\/web\/geek\/jobs\/?$/.test(path)||path==='/job_detail/'+message.jobId+'.html';
      const previewJob=message.preview&&previewPage&&jobId&&/^[a-zA-Z0-9_-]{1,150}$/.test(message.jobId)&&companyId&&message.title?.trim()&&message.title.trim().length<=200&&!found?.deleted;
      const related=companyId?visible.filter(j=>j.companyId===companyId):[];
      if(previewJob&&found&&!job)related.push(found);
      const latestMessages = await latestJobMessages(account, related, allJobs, conversations);
      let current=job?.id||(previewJob&&found?.id)||null;
      if(!jobId&&message.title){const matches=related.filter(j=>j.title===message.title);if(matches.length===1)current=matches[0].id;}
      const jobs: ExternalRecord[]=related.map(j=>({id:j.id,title:j.title,url:j.url||'',updatedAt:j.updatedAt,favorite:j.favorite===true,status:j.status||'unknown',label:j.autoLabel||'',manual:!!j.manual,current:j.id===current,note:j.note??'',persisted:true,firstConversationAt:earliest(j.firstConversationAt),...(Array.isArray(j.noteConflicts)&&j.noteConflicts.length?{noteConflicts:j.noteConflicts.filter((n: ExternalRecord)=>typeof n?.text==='string').map((n: ExternalRecord)=>({text:n.text}))}:{})}));
      for (const job of jobs) {
        const preview = latestMessages.get(job.id);
        if (preview) {
          const {text,direction,receipt}=preview;
          job.latestMessage = {text,direction,...(receipt?{receipt}:{})};
        }
      }
      if(!current&&!found&&(previewJob||(!message.preview&&message.title))){current=jobId;jobs.push({id:jobId,title:message.title,status:'unknown',manual:false,current:true,note:'',persisted:false,firstConversationAt:0});}
      jobs.sort((a,b)=>{const timeA=a.firstConversationAt||Infinity,timeB=b.firstConversationAt||Infinity;if(timeA!==timeB)return timeA<timeB?-1:1;if(a.id==null)return b.id==null?0:1;if(b.id==null)return -1;return a.id<b.id?-1:a.id>b.id?1:0;});
      return {ok:true,data:{companyId,companyName:company?.account===account?company!.name:(message.companyName||''),companyNote:company?.account===account?(company!.note??''):'',...(company?.account===account?{companyPersisted:true}:{}),settings:{},jobs,currentJobId:current}};
    });
    if(message.type==='DB_GET'&&(fromUI||fromSite))return serialize(async()=>{
      const account=fromSite?(message.account===undefined?tabAccounts.get(sender.tab!.id):message.account):(message.account===undefined?await currentAccount():await resolveAccount(message.account));
      if(fromSite)await requireSiteAccount(account,sender);
      await ensureStatusSchema(account);
      const snapshot=await data(account);
      if(fromUI&&account){
        snapshot.syncIntervalSeconds=syncIntervalSeconds(await meta(key(account,'syncIntervalSeconds'),undefined));
        const latestMessages=await latestJobMessages(account,snapshot.jobs,snapshot.jobs,snapshot.conversations,true);
        snapshot.jobs=jobsWithStatusTimes(snapshot.jobs,snapshot.events).map(job=>{
          const latestMessage=latestMessages.get(job.id);
          return latestMessage?{...job,latestMessage}:job;
        });
      }
      return {ok:true,data:snapshot};
    });
    if(message.type==='OPEN_DASHBOARD'&&fromSite){
      const account=message.account===undefined?tabAccounts.get(sender.tab!.id):message.account;
      if(typeof account!=='string'||!account)throw new Error('页面账号尚未识别，请稍后重试');
      await serialize(()=>requireSiteAccount(account,sender));
      const tab=await openDashboardTab(sender.tab!.windowId,message.view==='board'?'board':'collection',account);
      return {ok:true,tabId:tab?.id};
    }
    if(message.type==='SAVE_JOB'&&(fromUI||fromSite))return serialize(async()=>{if(fromSite)await requireSiteAccount(message.account,sender);return saveJob(message,fromSite?siteOrigin(sender.url):null);});
    if(message.type==='SAVE_COMPANY_NOTE'&&(fromUI||fromSite))return serialize(async()=>{
      if(typeof message.account!=='string'||!message.account)throw new Error('请选择账号');
      const account=await resolveAccount(message.account);
      if(fromSite)await requireSiteAccount(account,sender);
      validateNote(message.note);
      const hasExpectedNote=Object.hasOwn(message,'expectedNote');
      if(hasExpectedNote)validateNote(message.expectedNote);
      const company=await noteCompany(account,message.companyId,message.companyName);
      if(hasExpectedNote&&(company.note??'')!==message.expectedNote)throw new Error('备注冲突：内容已更改，请刷新后重试');
      await commit([['companies','put',{...company,note:message.note,updatedAt:Date.now()}]]);
      return {ok:true};
    });
    if(message.type==='DELETE_COMPANY'&&(fromUI||fromSite))return serialize(async()=>{
      const account=await resolveAccount(message.account);
      if(fromSite)await requireSiteAccount(account,sender);
      const companyId=message.companyId;
      if(typeof companyId!=='string'||!companyId.startsWith(key(account,'company:')))throw new Error('无效公司 ID');
      const company=await op('companies','get',companyId);
      if(!company||company.account!==account||company.deleted)throw new Error('找不到当前账号的公司');
      if(Object.hasOwn(message,'expectedNote')&&(company.note??'')!==message.expectedNote)throw new Error('公司备注已更改，请关闭浮层后重新确认');
      const jobs=(await op('jobs','getAll')).filter(job=>job.account===account&&job.companyId===companyId&&!job.deleted);
      const changes=await deleteJobs(account,jobs,companyId);
      changes.push(['companies','put',{id:companyId,account,deleted:true,deletedAt:Date.now()}]);
      await commit(changes);
      return {ok:true};
    });
    if(message.type==='DELETE_JOB'&&(fromUI||fromSite))return serialize(async()=>{
      const account=await resolveAccount(message.account);
      if(fromSite)await requireSiteAccount(account,sender);
      if(!validJobId(account,message.jobId))throw new Error('无效 JD ID');
      const job=await op('jobs','get',message.jobId);
      if(!job||job.account!==account||job.deleted)throw new Error('找不到当前账号的 JD');
      if(Object.hasOwn(message,'expectedUpdatedAt')&&message.expectedUpdatedAt!==job.updatedAt)throw new Error('职位已更改，请刷新后重新删除');
      await commit(await deleteJobs(account,[job]));
      chrome.runtime.sendMessage?.({type:'FAVORITES_CHANGED',account})?.catch(()=>{});
      return {ok:true};
    });
    if(!fromUI)throw new Error('此操作仅可在扩展页面中使用');
    if(message.type==='SET_SYNC_INTERVAL')return serialize(async()=>{
      if(!validSyncInterval(message.intervalSeconds))throw new Error('请求间隔必须是 '+syncInterval.min+'–'+syncInterval.max+' 秒之间的整数');
      const account=await resolveAccount(message.account);
      await setMeta(key(account,'syncIntervalSeconds'),message.intervalSeconds);
      return {ok:true};
    });
    if(message.type==='SELECT_ACCOUNT')return serialize(async()=>{if(message.account===undefined)throw new Error('请选择账号');const a=await resolveAccount(message.account);await setMeta('activeAccount',a);return {ok:true};});
    if(message.type==='EXPORT')return serialize(async()=>{const a=await resolveAccount(message.account);await ensureStatusSchema(a);const d=await data(a,true);d.messages=(await op('messages','getAll')).filter(x=>x.account===a);return {ok:true,data:d};});
    if(message.type==='SET_STATUS')return serialize(async()=>{const a=await resolveAccount(message.account);if(message.status!=='auto'&&!validStatus(message.status))throw new Error('无效状态');await ensureStatusSchema(a);const j=await op('jobs','get',message.jobId);if(!j||j.account!==a||j.deleted)throw new Error('找不到当前账号的 JD');j.manualStatus=message.status==='auto'?null:message.status;j.manual=!!j.manualStatus;j.status=j.manualStatus||j.autoStatus||'unknown';j.updatedAt=Date.now();await op('jobs','put',j);await addEvent(a,j.id,j.status,'manual',message.status==='auto'?'恢复自动状态':'用户修订');return {ok:true};});
    if(['SYNC','STOP_SYNC'].includes(message.type)){
      const account=await serialize(()=>resolveAccount(message.account));
      // Reserve under the DB queue, but never hold that queue while waiting for page ACKs.
      let task;
      let intervalSeconds: number | undefined;
      if(message.type==='SYNC'){
        const tab=await bossTab(account);
        task=await serialize(async()=>{
          const previous=await syncTask(account);
          if(previous.running)throw new Error('该账号已有更新正在进行');
          if(tabAccounts.get(tab.id)!==account)throw new Error('聊天页账号不匹配');
          intervalSeconds=syncIntervalSeconds(await meta(key(account,'syncIntervalSeconds'),undefined));
          const next={runId:crypto.randomUUID(),tabId:tab.id,running:true,complete:false,processed:0,failed:0,startedAt:Date.now(),updatedAt:Date.now(),message:'正在启动同步'};
          await setMeta(key(account,'sync'),next);return next;
        });
      }else{
        task=await serialize(async()=>{
          const current=await syncTask(account);
          if(!current.running)throw new Error('该账号没有正在运行的同步');
          const next={...current,stopping:true,complete:false,message:'正在停止同步',updatedAt:Date.now()};
          await setMeta(key(account,'sync'),next);return next;
        });
      }
      try{
        const response=await chrome.tabs.sendMessage(task.tabId,{type:message.type,account,runId:task.runId,...(intervalSeconds===undefined?{}:{intervalSeconds})});
        if(!response?.ok)throw new Error(response?.error||'网页未响应，请刷新 BOSS 聊天页');
        return {...response,runId:task.runId};
      }catch(error: any){
        await serialize(async()=>{
          const current=await meta(key(account,'sync'),{});
          if(current.runId===task.runId&&current.running)await setMeta(key(account,'sync'),{...current,running:false,complete:false,interrupted:true,message:String(error.message).slice(0,250),updatedAt:Date.now()});
        });
        throw error;
      }
    }
    throw new Error('未知操作');
  })().then(sendResponse).catch(error=>sendResponse({ok:false,error:String(error.message||error).slice(0,300)}));
  return true;
});
