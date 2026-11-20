export interface MockUser {userId: string; name: string; label: string}
export interface MockRow {
  encryptBossId: string;
  encryptJobId: string;
  encryptBrandId?: string;
  name: string;
  brandName: string;
  jobName: string;
  unreadCount: number | null;
  lastText: string;
  lastIsSelf?: boolean | null;
  lastMsgStatus?: number | null;
  closed?: boolean;
  securityId?: string;
  lastTS?: number;
  updateTime?: number;
}
export interface MockMessage {
  mid: string;
  time?: number;
  type: number;
  from?: {uid: string};
  to?: {uid: string};
  status: number;
  body: {type: number; text: string; dialog?: {title?: string; content?: string}; articles?: {title: string}[]; templateId?: number};
}
export interface MockConfig {
  scenario: string;
  account: string;
  user: MockUser;
  scenarios: Record<string, string>;
  accounts: Record<string, MockUser>;
}
export interface JobDetail {
  jobInfo: {encryptId: string; jobName: string; salaryDesc: string; locationName: string; experienceName: string; degreeName: string};
  brandComInfo: {brandName: string};
  relationInfo: {interestJob: boolean};
}
export interface JobFixtures {rows: MockRow[]; details: Record<string, JobDetail>; cases: Record<string, string>}
export interface RequestEntry {at: number; status: number; path: string; bossId: string; page?: string}
