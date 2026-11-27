export const labels: Record<string, string> = {
  unknown: '待确认', awaiting_contact: '待沟通', resume_event: '简历状态', resume_requested: '对方请求附件简历',
  awaiting_self: '待自己回复', awaiting_boss: '待 Boss 回复', unread: '未读', read: '已读未回复',
  greeting_unread: '已打招呼（对方未读）', greeting_read: '已打招呼（对方已读）',
  resume_applied: '附件简历请求已发送', resume_sent: '简历已发送', resume_viewed: '简历已查看',
  communication_rejected: '对方拒绝沟通', interviewing: '面试中', passed: '面试通过', failed: '面试失败',
};
export const normalizeStatus = (value: string) => /^interview_[1-9]\d*$/.test(value) ? 'interviewing' : value;
export const statusLabel = (value: string) => labels[normalizeStatus(value)] || '待确认';

function dayStart(now: number, daysAgo: number) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.getTime();
}

function monthStart(now: number, monthsAgo: number) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() - monthsAgo);
  date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  return date.getTime();
}

export function formatRelativeStatusDate(value?: number, now = Date.now()): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  if (value >= dayStart(now, 0)) return '当天';
  if (value >= dayStart(now, 1)) return '1 天内';
  if (value >= dayStart(now, 3)) return '3 天内';
  if (value >= dayStart(now, 7)) return '1 周内';
  if (value >= monthStart(now, 1)) return '1 周前';
  if (value >= monthStart(now, 3)) return '1 个月前';
  return '3 个月前';
}

export function jobURL(value?: string) {
  try {
    const url = new URL(value || '');
    const allowed = ['https://www.zhipin.com', 'http://127.0.0.1:4173', 'http://localhost:4173'].includes(url.origin);
    return allowed && /^\/job_detail\/[a-zA-Z0-9_-]+\.html$/.test(url.pathname) ? url.origin + url.pathname : '';
  } catch { return ''; }
}
