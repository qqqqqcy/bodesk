import {activityDateLabel, boardColumnLabels, describeBoardFilters, formatBoardDateTime, groupBoardJobs} from './job-board.tsx';
import type {BoardJob, BoardPreferences} from './job-board.tsx';
import {messageSenders} from './message-receipt.tsx';
import {formatRelativeStatusDate} from './status.ts';

function indentMultiline(value: string) {
  return value.trim().replace(/\r?\n/g, '\n  ');
}

function formatTimeWithRelative(value: number, now: number) {
  if (!value) return '';
  const exact = formatBoardDateTime(value);
  const relative = formatRelativeStatusDate(value, now);
  return relative && relative !== exact ? exact + ' · ' + relative : exact;
}

function formatJobTags(job: BoardJob) {
  const tags: string[] = [];
  if (job.favorite) tags.push('已收藏职位');
  if (job.companyFavorite) tags.push('已收藏公司');
  if (job.jobClosed) {
    const closedAt = job.jobClosedObservedAt ? formatBoardDateTime(job.jobClosedObservedAt) : '';
    tags.push(closedAt ? '职位已关闭（' + closedAt + '）' : '职位已关闭');
  }
  return tags;
}

function formatStatusLine(job: BoardJob, now: number) {
  const parts: string[] = [];
  if (job.detail) parts.push(job.detail);
  const time = formatTimeWithRelative(job.statusAt, now);
  if (time) parts.push(time);
  return parts.length ? job.statusText + '（' + parts.join('，') + '）' : job.statusText;
}

function formatLatestMessage(job: BoardJob, now: number) {
  const message = job.latestMessage;
  if (!message) return '';
  const meta: string[] = [];
  if (message.direction === 'out' && message.receipt) meta.push(message.receipt === 'read' ? '已读' : '已送达');
  const time = formatTimeWithRelative(message.time, now);
  if (time) meta.push(time);
  if (message.fromList) meta.push('聊天摘要');
  const header = messageSenders[message.direction] + (meta.length ? '（' + meta.join('，') + '）' : '');
  const text = indentMultiline(message.text);
  return text.includes('\n') ? header + '：\n  ' + text : header + '：' + text;
}

function formatNoteLine(label: string, raw: string) {
  const text = indentMultiline(raw);
  return text.includes('\n') ? '- ' + label + '：\n  ' + text : '- ' + label + '：' + text;
}

export function formatBoardMarkdown({jobs, totalCount, preferences, now, accountName}: {
  jobs: BoardJob[];
  totalCount: number;
  preferences: BoardPreferences;
  now: number;
  accountName?: string;
}): string {
  const groups = groupBoardJobs(jobs, preferences.groupBy);
  const filters = describeBoardFilters(preferences.filters);
  const lines: string[] = [
    '# BoDesk JD 看板摘要',
    '',
    '- 导出时间：' + formatBoardDateTime(now),
  ];
  if (accountName?.trim()) lines.push('- 账号：' + accountName.trim());
  lines.push(
    '- 活动时间：' + activityDateLabel(preferences.range, now) + ' 至 ' + activityDateLabel(preferences.rangeEnd, now),
    '- 分组方式：按' + boardColumnLabels[preferences.groupBy],
    '- 筛选条件：' + (filters.length ? filters.join('；') : '无'),
  );
  const countSummary = jobs.length === totalCount
    ? '共 ' + jobs.length + ' 个 JD'
    : '当前筛选 ' + jobs.length + ' / ' + totalCount + ' 个 JD';
  const groupSummary = groups.length ? '（' + groups.map(group => group.label + ' ' + group.jobs.length).join('、') + '）' : '';
  lines.push('- 统计：' + countSummary + '，共 ' + groups.length + ' 组' + groupSummary);

  for (const group of groups) {
    lines.push('', '## ' + group.label + '（' + group.jobs.length + ' 个 JD）');
    group.jobs.forEach((job, index) => {
      const titleSuffix = preferences.groupBy === 'company' ? '' : '｜' + job.company;
      lines.push('', '### ' + (index + 1) + '. ' + job.title + titleSuffix);
      const tags = formatJobTags(job);
      if (tags.length) lines.push('- 标签：' + tags.join('、'));
      lines.push('- 状态：' + formatStatusLine(job, now));
      if (job.conditions.length) lines.push('- 职位条件：' + job.conditions.join(' · '));
      const latestMessage = formatLatestMessage(job, now);
      if (latestMessage) lines.push('- 最后对话：' + latestMessage);
      if (job.note.trim()) lines.push(formatNoteLine('JD 备注', job.note));
      if (job.companyNote.trim()) lines.push(formatNoteLine('公司备注', job.companyNote));
      if (job.url) lines.push('- 链接：' + job.url);
    });
  }

  return lines.join('\n') + '\n';
}
