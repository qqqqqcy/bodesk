export type ExternalRecord = Record<string, any>;

export interface Contribution {
  status: string;
  label?: string;
  observedAt?: number;
  evidence?: string;
  priority?: number;
  interviewClosedAt?: number;
}

export interface Contributions {
  verified?: Contribution;
  unverified?: Contribution;
}

export interface MessageRecord {
  time?: number;
  text?: string;
  type?: number;
  bodyType?: number;
  templateId?: number;
  messageType?: string;
  isSystem?: boolean | null;
  direction?: string;
}

export interface ConversationRecord {
  lastText?: string;
  lastMessageAt?: number;
  time?: number;
  lastIsSelf?: boolean | null;
}

export interface JobRecord extends ExternalRecord {
  jobClosed?: boolean;
  jobClosedObservedAt?: number;
  autoContributions?: Record<string, Contributions>;
  manualStatus?: string | null;
  statusAt?: number;
  statusActivityAt?: number;
  latestMessage?: TimedHumanMessagePreview;
  messageActivity?: number[];
  conversationIds?: string[];
}

export interface WidgetContext {
  account: string;
  jobId: string;
  companyName: string;
  title: string;
  preview?: boolean;
  jobClosed?: boolean;
}

export interface HumanMessagePreview {
  text: string;
  direction: 'in' | 'out' | 'unknown';
  receipt?: 'delivered' | 'read';
}

export interface TimedHumanMessagePreview extends HumanMessagePreview {
  time: number;
  fromList?: boolean;
}

export interface WidgetJob {
  id: string;
  title: string;
  url?: string;
  status: string;
  label?: string;
  manual?: boolean;
  statusAt?: number;
  current?: boolean;
  favorite?: boolean;
  jobClosed?: boolean;
  persisted?: boolean;
  updatedAt?: number;
  latestMessage?: HumanMessagePreview;
  note?: string;
  noteConflicts?: {text: string}[];
}

export interface WidgetData {
  companyId?: string;
  companyName?: string;
  companyNote?: string;
  companyPersisted?: boolean;
  companyFavorite?: boolean;
  companyDeleted?: boolean;
  jobs?: WidgetJob[];
}

export interface SyncState {
  running?: boolean;
  complete?: boolean;
  processed?: number;
  total?: number;
  failed?: number;
  updatedAt?: number;
  coverage?: string;
  message?: string;
  [key: string]: unknown;
}

export interface DatabaseSnapshot {
  account: string | null;
  accounts: string[];
  accountNames: Record<string, string>;
  conversations: unknown[];
  jobs: JobRecord[];
  companies: ExternalRecord[];
  sync: SyncState;
  syncIntervalSeconds: number;
}

declare global {
  interface Window {
    __bossLocalHelper?: boolean;
    _PAGE?: {uid: string | number; name?: string};
  }
  interface Element {
    __vue__?: ExternalRecord;
  }
}
