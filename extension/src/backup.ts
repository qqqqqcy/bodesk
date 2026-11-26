import type {ExternalRecord} from './types.ts';

const backupStores = ['companies', 'jobs', 'conversations', 'messages', 'events'] as const;
type BackupStore = typeof backupStores[number];
type BackupGroup = 'real' | 'mock';
export const maxBackupBytes = 32 * 1024 * 1024;

export async function backupText(file: File) {
  if (file.size > maxBackupBytes) throw new Error('备份文件不能超过 32 MB');
  return file.text();
}

const prefixes: Record<BackupStore, string> = {companies: 'company:', jobs: 'job:', conversations: 'conversation:', messages: 'message:', events: ''};
const optionalText = (value: unknown) => value == null || typeof value === 'string';
const record = (value: unknown): value is ExternalRecord => !!value && typeof value === 'object' && !Array.isArray(value);

function checkValue(value: unknown, depth: number): void {
  if (depth > 16 || typeof value === 'number' && !Number.isFinite(value) || typeof value === 'string' && value.length > 10000) throw new Error('备份包含无效数据');
  if (Array.isArray(value)) for (const item of value) checkValue(item, depth + 1);
  if (record(value)) for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('备份包含无效字段');
    checkValue(item, depth + 1);
  }
}

function isBackupRecord(store: BackupStore, row: unknown, account: string): row is ExternalRecord {
  const id = (value: unknown, prefix: string) => typeof value === 'string' && value.startsWith(account + ':' + prefix) && value.length > account.length + prefix.length + 1;
  const ids = (value: unknown, prefix: string) => value == null || Array.isArray(value) && value.every(item => id(item, prefix));
  const ref = (value: unknown, prefix: string) => value == null || value === '' || id(value, prefix);
  if (!record(row) || row.account !== account || !id(row.id, prefixes[store])) return false;
  if (store === 'companies') return typeof row.name === 'string' && optionalText(row.note);
  if (store === 'conversations') return ref(row.companyId, 'company:') && ids(row.jobIds, 'job:') && optionalText(row.jobId) && optionalText(row.lastText);
  if (store === 'messages') return id(row.conversationId, 'conversation:') && optionalText(row.messageId) && optionalText(row.jobId) && optionalText(row.text);
  if (store === 'events') return ref(row.jobId, 'job:') && (ref(row.conversationId, 'conversation:') || row.source === 'sync_error' && optionalText(row.conversationId));
  const contributions = row.autoContributions;
  return typeof row.title === 'string' && ref(row.companyId, 'company:') && ref(row.conversationId, 'conversation:') && ids(row.conversationIds, 'conversation:') &&
    optionalText(row.note) && optionalText(row.url) && optionalText(row.status) && optionalText(row.autoStatus) && optionalText(row.manualStatus) &&
    (contributions == null || record(contributions) && Object.entries(contributions).every(([key, entry]) => id(key, 'conversation:') && record(entry) &&
      [entry.verified, entry.unverified].every(candidate => candidate == null || record(candidate) && typeof candidate.status === 'string')));
}

export function readBackup(json: unknown) {
  if (typeof json !== 'string' || json.length > maxBackupBytes) throw new Error('备份文件过大或无效');
  let data: unknown;
  try {data = JSON.parse(json);} catch {throw new Error('文件不是有效的 JSON');}
  if (!record(data) || typeof data.account !== 'string' || !/^[a-f0-9]{24}$/.test(data.account)) throw new Error('请选择 BoDesk 导出的账号备份');
  const {account, sourceGroup} = data;
  if (sourceGroup !== undefined && sourceGroup !== 'real' && sourceGroup !== 'mock') throw new Error('备份的账号来源无效');
  const tables: [BackupStore, ExternalRecord[]][] = [];
  for (const store of backupStores) {
    const rows = data[store];
    if (!Array.isArray(rows)) throw new Error('备份缺少 ' + store + ' 记录');
    const seen = new Set<string>();
    for (const row of rows) {
      if (!isBackupRecord(store, row, account) || seen.has(row.id)) throw new Error('备份包含无效或重复的 ' + store + ' 记录');
      checkValue(row, 0);
      seen.add(row.id);
    }
    tables.push([store, rows]);
  }
  return {account, sourceGroup: sourceGroup as BackupGroup | undefined, tables};
}
