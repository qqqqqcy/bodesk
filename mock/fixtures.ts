import type {MockUser, MockRow, MockMessage} from './src/types.ts';

interface MockConversation {key: string; row: MockRow; messages: MockMessage[]; detail: {data: {encryptJobId: string; companyName: string; bothTalked: boolean}; job: {jobName: string; brandName: string; salaryDesc: string; locationName: string; experienceName: string; degreeName: string}}}
export interface MockWorld {scenario: string; account: string; user: MockUser; conversations: MockConversation[]; favoriteJobIds: string[]; nextId: number; requests: {path: string; bossId: string | null; cursor: string | null; page: string | null; at: number; status: number}[]; deletionProbe?: string}

export const SCENARIOS: Record<string, string> = {
  normal: '日常沟通 · 状态与排序覆盖',
  unknown_direction: '消息方向缺失 · 列表回退或待确认',
  ambiguous_resume: '简历提示冲突 · 同时 / 无时间',
  multipage: '多页历史 · 每联系人 45 条',
  empty: '空账号',
  partial: '联系人尚未全部加载',
  stalled: '第二页游标停滞',
  rate_limit: '第二页 HTTP 429',
  unauthorized: 'HTTP 401 · 登录失效',
  forbidden: 'HTTP 403 · 需要验证',
  server_error: 'HTTP 500',
  invalid_json: '返回非 JSON',
  malformed: '历史字段结构异常',
  business_error: '业务 code 非零',
  slow: '慢接口 · 16 秒'
};

export const ACCOUNTS: Record<string, MockUser> = {
  alpha: {userId: 'mock-geek-alpha', name: '林同学', label: '账号 A · 林同学'},
  beta: {userId: 'mock-geek-beta', name: '陈同学', label: '账号 B · 陈同学'}
};

// Keep these ranges stable when adding/reordering the scenario catalog: plugin history survives resets.
const MESSAGE_OFFSETS: Record<string, number> = {
  normal: 0, unknown_direction: 1000000, ambiguous_resume: 2000000,
  multipage: 3000000, empty: 4000000, partial: 5000000, stalled: 6000000,
  rate_limit: 7000000, unauthorized: 8000000, forbidden: 9000000,
  server_error: 10000000, invalid_json: 11000000, malformed: 12000000,
  business_error: 13000000, slow: 14000000
};
const BASE_TIME = Date.UTC(2026, 10, 16, 2);
const CONTACTS: [string, string, string, string, string, number | null, string, boolean | null, number | null][] = [
  ['request', '林沐', '星河科技', '前端工程师', 'frontend', 2, '你好，可以发一份简历吗？', false, 2],
  ['awaiting_boss', '周然', '星河科技', '全栈工程师', 'fullstack', 0, '你好，想了解一下这个岗位。', true, 1],
  ['viewed', '何悦', '云帆数据', '数据平台工程师', 'data', 0, '对方已查看了您的附件简历', false, 2],
  ['sent', '陆川', '木禾设计', '产品设计师', 'design', 0, '您的附件简历已发送给Boss', true, 2],
  ['awaiting_self', '许宁', '星河科技', '前端工程师', 'frontend', 1, '期待进一步沟通', false, 2],
  ['no_job', '苏晴', '远山实验室', '职位待确认', '', null, '这个机会目前还在沟通中', false, null],
  ['earlier_resume', '顾言', '星河科技', '后端工程师', 'backend', 0, '下周可以继续聊聊团队。', false, 2],
  ['no_messages', '唐溪', '星河科技', '质量工程师', 'quality', 0, '', null, null],
  ['unknown_resume', '沈禾', '青石科技', '算法工程师', 'algorithm', 0, '对方正在审核您的附件简历', false, 2],
  ['withdrawn', '方舟', '海风科技', '运维工程师', 'operations', 0, '对方撤回了一条消息', false, 2],
  ['system_only', '罗青', '竹林科技', '测试工程师', 'testing', 0, '您已与对方建立沟通', null, null],
  ['dialog_request', '江月', '明湖科技', '移动端工程师', 'mobile', 1, '希望获取您的附件简历', false, 2],
  ['xss', '<script>window.__xss = true</script>安全姓名' + '长'.repeat(120), '白鹭科技', '<script>window.__xss = true</script>安全职位' + '长文本'.repeat(120), 'safe-text', 0, '请查看职位介绍。', false, 2],
  ['applied', '温澜', '拾光科技', '项目经理', 'project', 0, '附件简历请求已发送', true, 1],
  ['resume_failed', '秦雨', '松柏科技', '安全工程师', 'security', 0, '简历发送失败', true, 1],
  ['resume_rejected', '程墨', '冬青科技', '客户端工程师', 'client', 0, '对方已拒绝您的简历', false, 2]
];

const SYSTEM_KEYS = new Set(['viewed', 'sent', 'unknown_resume', 'system_only', 'applied', 'resume_failed', 'resume_rejected']);

export function createWorld({scenario = 'normal', account = 'alpha'} = {}): MockWorld {
  if (!Object.hasOwn(SCENARIOS, scenario) || !Object.hasOwn(ACCOUNTS, account)) throw new Error('未知场景或账号');
  const user = {...ACCOUNTS[account]};
  const messageOffset = MESSAGE_OFFSETS[scenario];
  const shortHistory = ['normal', 'partial', 'unknown_direction', 'ambiguous_resume'].includes(scenario);
  const conversations = (scenario === 'empty' ? [] : CONTACTS).map((entry, index) => {
    const [key, name, company, title, job, unreadCount, lastText, lastIsSelf, lastMsgStatus] = entry;
    const row: MockRow = {
      encryptBossId: account + '-' + scenario + '-boss-' + (index + 1), securityId: 'synthetic-local-only',
      encryptJobId: job ? account + '-' + scenario + '-job-' + job : '', name,
      brandName: company, jobName: title, unreadCount, lastText, lastIsSelf, lastMsgStatus
    };
    // Separate contact start times make each populated JD's earliest message sortable.
    const startTime = BASE_TIME + index * 3600000;
    const count = shortHistory && key === 'no_messages' ? 0 : shortHistory ? 4 : 45;
    const messages: MockMessage[] = Array.from({length: count}, (_, messageIndex) => {
      const outgoing = messageIndex === count - 1 ? lastIsSelf === true : messageIndex % 2 === 1;
      const last = messageIndex === count - 1;
      const body = {type: last && SYSTEM_KEYS.has(key) ? 4 : 1,
        text: last ? lastText : outgoing ? '这是我的第 ' + (messageIndex + 1) + ' 条沟通记录，希望了解团队和工作内容。' : '关于' + title + '，我们可以继续聊聊。历史消息 ' + (messageIndex + 1) + '。'};
      return {mid: String(messageOffset + 100000 + index * 1000 + messageIndex), time: startTime + messageIndex * 60000,
        type: 1, from: {uid: outgoing ? user.userId : row.encryptBossId},
        to: {uid: outgoing ? row.encryptBossId : user.userId}, status: outgoing ? (lastMsgStatus ?? 1) : 2, body};
    });
    if (shortHistory) {
      if (key === 'earlier_resume') messages[1].body = {type: 4, text: '您的附件简历已发送给Boss'};
      if (key === 'system_only') for (const message of messages) message.body = {type: 4, text: '您已与对方建立沟通'};
      // Leave body.text empty to exercise both HTTP and page dialog extraction.
      if (key === 'dialog_request') messages.at(-1)!.body = {type: 7, text: '', dialog: {content: '希望获取您的附件简历'}};
      if (key === 'withdrawn') {
        messages[2].body.text = '我已经补充了项目介绍，期待回复。';
        messages[2].from!.uid = user.userId;
        messages[2].to!.uid = row.encryptBossId;
      }
    }
    Object.assign(row, {lastTS: messages.at(-1)?.time ?? 0, updateTime: messages.at(-1)?.time ?? startTime});
    return {key, row, messages, detail: {
      data: {encryptJobId: row.encryptJobId, companyName: company, bothTalked: true},
      job: {jobName: title, brandName: company, salaryDesc: index % 2 ? '25-40K·14薪' : '20-35K·14薪', locationName: '上海', experienceName: '3-5年', degreeName: '本科'}
    }};
  });
  if (scenario === 'unknown_direction') {
    // Include both wholly missing endpoints and present but unidentifiable endpoints.
    for (const [index, direction] of [[0, true], [1, false], [2, null]] as const) {
      const conversation = conversations[index];
      // Dedicated identities keep both peer contributions and previously collected fixtures out of these demos.
      conversation.row.encryptBossId += '-direction';
      conversation.row.encryptJobId += '-direction';
      conversation.detail.data.encryptJobId = conversation.row.encryptJobId;
      for (const [offset, message] of conversation.messages.entries()) {
        delete message.from;
        delete message.to;
        if (offset % 2) {message.from = {uid: 'unresolved-sender'}; message.to = {uid: 'unresolved-recipient'};}
        message.body = {type: 1, text: '方向缺失的普通沟通 ' + (offset + 1)};
      }
      Object.assign(conversation.row, {lastText: '方向缺失的普通沟通 4', lastIsSelf: direction,
        lastTS: conversation.messages.at(-1)!.time, updateTime: conversation.messages.at(-1)!.time});
    }
  }
  if (scenario === 'ambiguous_resume') {
    const labels = ['您的附件简历已发送给Boss', '对方已查看了您的附件简历'];
    for (const [index, mode] of [[0, 'same'], [1, 'missing'], [2, 'single']] as const) {
      const conversation = conversations[index];
      conversation.messages = conversation.messages.slice(0, mode === 'single' ? 1 : 2);
      conversation.messages.forEach((message, offset) => {
        message.body = {type: 4, text: labels[offset]};
        if (mode === 'same') message.time = BASE_TIME;
        else delete message.time;
      });
      Object.assign(conversation.row, {lastText: conversation.messages.at(-1)!.body.text, lastTS: mode === 'same' ? BASE_TIME : 0});
    }
  }
  const prefix=account+'-'+scenario;
  const favoriteJobIds=scenario==='empty'?[]:[conversations.find(item=>item.row.encryptJobId)?.row.encryptJobId,prefix+'-favorite-only',prefix+'-favorite-closed'].filter((value): value is string => Boolean(value));
  return {scenario, account, user, conversations, favoriteJobIds, nextId: messageOffset + 900000, requests: []};
}

export function listRows(world: MockWorld, limit = Infinity) {
  return world.conversations.slice(0, limit).map(({row}) => structuredClone(row));
}

export function jobPageFixtures(world: MockWorld) {
  const records = new Map(listRows(world).filter(row => row.encryptJobId).map(row => [row.encryptJobId, row]));
  const first = records.values().next().value;
  const prefix = world.account + '-' + world.scenario;
  const company = first?.brandName || '星河科技';
  const previews = [
    {encryptJobId: prefix + '-preview-only', jobName: '尚未沟通的新职位', brandName: company},
    {encryptJobId: prefix + '-preview-company', jobName: '新公司的前端工程师', brandName: '未沟通示例公司'},
    {encryptJobId: prefix + '-preview-same-title', jobName: first?.jobName || '前端工程师', brandName: company}
  ];
  const favoriteRows=world.scenario==='empty'?[]:[{encryptJobId:prefix+'-favorite-only',jobName:'收藏的全栈工程师',brandName:company},{encryptJobId:prefix+'-favorite-closed',jobName:'已下架的收藏职位',brandName:'收藏示例公司',closed:true}];
  const deleteRows=world.deletionProbe&&world.scenario!=='empty'?[{encryptJobId:prefix+'-delete-card-'+world.deletionProbe,jobName:'卡片删除演示职位',brandName:'删除演示公司'}]:[];
  const rows = [...records.values(), ...favoriteRows, ...previews, ...deleteRows].map(row => ({encryptJobId: row.encryptJobId, jobName: row.jobName,closed:'closed' in row && !!row.closed,
    brandName: row.brandName, encryptBrandId: prefix + '-brand-' + encodeURIComponent(row.brandName),
    salaryDesc: '20-40K', jobExperience: '3-5年', jobDegree: '本科'}));
  const details = Object.fromEntries(rows.map(row => [row.encryptJobId, {
    pageType: 0, selfAccess: false,
    jobInfo: {encryptId: row.encryptJobId, jobName: row.jobName, salaryDesc: row.salaryDesc,
      locationName: '北京', experienceName: row.jobExperience, degreeName: row.jobDegree,
      postDescription: '与团队协作，构建稳定的产品体验。这是虚构的本地模拟职位。'},
    brandComInfo: {encryptBrandId: row.encryptBrandId, brandName: row.brandName, stageName: '未融资', scaleName: '100-499人', industryName: '互联网'},
    bossInfo: {name: '模拟招聘经理', title: '招聘经理'}, relationInfo: {interestJob:world.favoriteJobIds.includes(row.encryptJobId),beFriend:false}
  }]));
  return {rows, details, initialJobId: first?.encryptJobId || previews[0].encryptJobId,
    cases: {existing: first?.encryptJobId || null, companyOnly: previews[0].encryptJobId,
      unknownCompany: previews[1].encryptJobId, sameTitleDifferentId: previews[2].encryptJobId,deleteByCard:deleteRows[0]?.encryptJobId||null}};
}

export function historyPage(conversation: MockConversation, {cursor = '0', count = 20, stalled = false} = {}) {
  const newest = [...conversation.messages].sort((first, second) => Number(second.mid) - Number(first.mid));
  const start = cursor === '0' ? 0 : newest.findIndex(message => message.mid === String(cursor)) + 1;
  if (cursor !== '0' && start === 0) throw new Error('无效历史游标');
  const messages = newest.slice(start, start + count);
  return {messages: structuredClone(messages), hasMore: start + messages.length < newest.length,
    minMsgId: stalled && cursor !== '0' ? String(cursor) : messages.at(-1)?.mid ?? '0'};
}

export function switchJob(world: MockWorld, bossId: string) {
  const conversation = world.conversations.find(item => item.row.encryptBossId === bossId);
  if (!conversation) throw new Error('联系人不存在');
  const target = world.conversations.find(item => item.row.brandName === conversation.row.brandName && item.row.encryptJobId && item.row.encryptJobId !== conversation.row.encryptJobId);
  if (!target) throw new Error('该公司没有可切换的其他 JD；请选择星河科技联系人');
  conversation.row.encryptJobId = target.row.encryptJobId;
  conversation.row.jobName = target.row.jobName;
  conversation.detail = structuredClone(target.detail);
  return structuredClone(conversation.row);
}

export function appendMessage(world: MockWorld, bossId: string, {kind = 'text', text = ''} = {}) {
  const conversation = world.conversations.find(item => item.row.encryptBossId === bossId);
  if (!conversation) throw new Error('联系人不存在');
  const outgoing = !['request_resume', 'view_resume', 'withdraw', 'unknown_resume', 'resume_failed', 'invite_interview', 'cancel_interview', 'competition_card', 'wechat_card'].includes(kind);
  const templates: Record<string, string> = {resume: '您的附件简历已发送给Boss', apply_resume: '附件简历请求已发送', request_resume: '希望获取您的附件简历', view_resume: '对方已查看了您的附件简历', withdraw: '对方撤回了一条消息', unknown_resume: '对方正在审核您的附件简历', resume_failed: '简历发送失败\n对方已拒绝您的简历'};
  const interviewTemplates: Record<string, string> = {invite_interview: '模拟招聘方邀请您线上面试，请查收会议安排', accept_interview: '接受了面试邀请', cancel_interview: '对方取消了面试'};
  const platformTemplates: Record<string, string> = {competition_card: '你与该职位竞争者PK情况', wechat_card: '模拟联系人的微信号：mock_wechat'};
  const interview = Object.hasOwn(interviewTemplates, kind);
  if (kind !== 'text' && !Object.hasOwn(templates, kind) && !interview && !Object.hasOwn(platformTemplates, kind)) throw new Error('未知消息类型');
  const content = kind === 'text' ? String(text).trim().slice(0, 2000) : (interview ? interviewTemplates[kind] : platformTemplates[kind] ?? templates[kind]);
  if (!content) throw new Error('消息不能为空');
  const system = ['resume', 'apply_resume', 'view_resume', 'unknown_resume', 'resume_failed'].includes(kind);
  let body: MockMessage['body'] = {type: system ? 4 : 1, text: content};
  if (interview) body = {type: 14, templateId: 1, text: content};
  if (kind === 'request_resume') body = {type: 7, text: '', dialog: {content}};
  if (kind === 'competition_card') body = {type: 16, templateId: 1, text: '', articles: [{title: content}]};
  if (kind === 'wechat_card') body = {type: 1, templateId: 5, text: content};
  const time = Math.max(Date.now(), ...conversation.messages.map(message => (Number(message.time) || 0) + 1));
  const message = {mid: String(world.nextId++), time, type: kind === 'competition_card' ? 4 : interview ? 3 : 1,
    from: {uid: outgoing ? world.user.userId : bossId}, to: {uid: outgoing ? bossId : world.user.userId},
    status: outgoing ? 1 : 2, body};
  conversation.messages.push(message);
  Object.assign(conversation.row, {lastText: content, lastIsSelf: outgoing, lastMsgStatus: message.status,
    unreadCount: outgoing ? conversation.row.unreadCount : (conversation.row.unreadCount ?? 0) + 1, lastTS: message.time, updateTime: message.time});
  return structuredClone(message);
}
