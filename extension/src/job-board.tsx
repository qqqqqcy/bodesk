import {useEffect, useMemo, useRef, useState} from 'react';
import type {CSSProperties, PointerEvent} from 'react';
import {flexRender, getCoreRowModel, getFilteredRowModel, getGroupedRowModel, getSortedRowModel, useReactTable} from '@tanstack/react-table';
import type {ColumnDef, TableState} from '@tanstack/react-table';
import {ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Loader, Trash} from 'reicon';
import {FavoriteMark, Icon} from './icon.tsx';
import {BoardEditor} from './board-editor.tsx';
import type {BoardEdit} from './board-editor.tsx';
import {resumeEventStage} from './core.ts';
import {NoteIcon} from './record-editing.tsx';
import {formatRelativeStatusDate, jobURL, normalizeStatus, statusLabel} from './status.ts';
import type {DatabaseSnapshot, ExternalRecord, TimedHumanMessagePreview} from './types.ts';
import {MessageReceipt, messageSenders} from './message-receipt.tsx';
import {DashboardSelect} from './dashboard-select.tsx';
import {withinActivityWindow} from './activity-window.ts';
import type {ActivityWindow} from './activity-window.ts';

const statusOrder = new Map([
  'passed', 'interviewing', 'failed', 'resume_viewed', 'resume_sent', 'resume_applied', 'resume_event',
  'resume_requested', 'awaiting_self', 'awaiting_boss', 'communication_rejected',
  'greeting_read', 'greeting_unread', 'read', 'unread', 'unknown', 'awaiting_contact',
].map((status, index) => [status, index]));

export interface BoardJob {
  id: string;
  title: string;
  company: string;
  companyId: string;
  companyNote: string;
  companyFavorite: boolean;
  favorite: boolean;
  jobClosed: boolean;
  jobClosedObservedAt: number;
  conditions: string[];
  status: string;
  detail: string;
  note: string;
  url: string;
  statusAt: number;
  statusActivityAt: number;
  messageActivity: number[];
  manual: boolean;
  manualStatus: string | null;
  statusText: string;
  updatedAt?: number;
  latestMessage?: TimedHumanMessagePreview;
}

const columnLabels = {title: '职位', company: '公司', favorite: '收藏', latestMessage: '最后一条对话', status: '状态', detail: '状态说明与备注', conditions: '职位条件'};
export type BoardColumn = 'status' | 'company' | 'favorite';
export const boardColumnLabels: Record<BoardColumn, string> = {status: columnLabels.status, company: columnLabels.company, favorite: columnLabels.favorite};
const boardColumnOptions = [{value: 'status', label: columnLabels.status}, {value: 'company', label: columnLabels.company}, {value: 'favorite', label: columnLabels.favorite}] as const;
const isBoardColumn = (value: unknown): value is BoardColumn => value === 'status' || value === 'company' || value === 'favorite';

type FavoriteGroup = 'job' | 'company' | 'none';
const favoriteGroupLabels: Record<FavoriteGroup, string> = {job: '已收藏职位', company: '已收藏公司', none: '未收藏'};
const favoriteOrder = new Map<FavoriteGroup, number>([['job', 0], ['company', 1], ['none', 2]]);
const favoriteFilterOptions = [
  {value: 'any', label: '已收藏'},
  {value: 'job', label: '已收藏职位'},
  {value: 'company', label: '已收藏公司'},
  {value: 'none', label: '未收藏'},
] as const;
type FavoriteFilterValue = (typeof favoriteFilterOptions)[number]['value'];
const isFavoriteFilterValue = (value: unknown): value is FavoriteFilterValue =>
  value === 'any' || value === 'job' || value === 'company' || value === 'none';

const filterOperators = {contains: '包含', excludes: '不包含', equals: '等于', differs: '不等于', empty: '为空', filled: '不为空'};
type FilterOperator = keyof typeof filterOperators;
const operatorOptions = (Object.keys(filterOperators) as FilterOperator[]).map(value => ({value, label: filterOperators[value]}));
const favoriteOperatorOptions = [{value: 'equals', label: filterOperators.equals}, {value: 'differs', label: filterOperators.differs}] as const;
export interface BoardFilter {column: BoardColumn; operator: FilterOperator; value: string}
const emptyFilter: BoardFilter = {column: 'status', operator: 'contains', value: ''};

export interface BoardPreferences {
  range: number;
  rangeEnd: number;
  collapsed: string[];
  groupBy: BoardColumn;
  filters: BoardFilter[];
}

const today = 0;
const ranges = ['当天', ...Array.from({length: 15}, (_, index) => (index + 1) + ' 天'), '1 个月', '2 个月', '3 个月', '不限'];
const allTime = ranges.length - 1;
const baseRangeMarks = [today, 5, 10, 15, 17, allTime];
const preferencesKey = 'boss-helper.jd-board.preferences';
const defaultPreferences: BoardPreferences = {range: 7, rangeEnd: today, collapsed: [], groupBy: 'status', filters: []};

function readPreferences(fallback = defaultPreferences): BoardPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(preferencesKey) ?? 'null');
    if (!stored) return fallback;
    const {range, rangeEnd, collapsed, groupBy, filters} = stored;
    const start = Number.isInteger(range) && range >= today && range <= allTime ? range : fallback.range;
    return {
      range: start,
      rangeEnd: Number.isInteger(rangeEnd) && rangeEnd >= today && rangeEnd < allTime ? Math.min(rangeEnd, start) : today,
      collapsed: Array.isArray(collapsed) ? collapsed.filter(value => typeof value === 'string') : fallback.collapsed,
      groupBy: isBoardColumn(groupBy) ? groupBy : fallback.groupBy,
      filters: Array.isArray(filters) ? filters.filter(filter => {
        if (!filter || !isBoardColumn(filter.column) || typeof filter.value !== 'string') return false;
        if (filter.column === 'favorite') return (filter.operator === 'equals' || filter.operator === 'differs') && isFavoriteFilterValue(filter.value);
        return Object.hasOwn(filterOperators, filter.operator);
      }) : fallback.filters,
    };
  } catch {return fallback;}
}

function activityDay(range: number, now: number) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  if (range <= 15) date.setDate(date.getDate() - range);
  else {
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() - (range - 15));
    date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  }
  return date;
}

const activityDateFormat = new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: '2-digit', day: '2-digit'});
export const activityDateLabel = (step: number, now: number) => step === allTime ? ranges[allTime] : activityDateFormat.format(activityDay(step, now));
const rangePosition = (step: number) => (step / allTime) * 100 + '%';

export function boardActivityWindow({range, rangeEnd}: BoardPreferences, now: number): ActivityWindow | null {
  if (range === allTime && rangeEnd === today) return null;
  const end = activityDay(rangeEnd, now);
  return {start: range === allTime ? null : activityDay(range, now).getTime(), end: rangeEnd === today ? now : end.setDate(end.getDate() + 1) - 1};
}

export function useBoardPreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  function savePreferences(update: (current: BoardPreferences) => BoardPreferences) {
    const next = update(readPreferences(preferences));
    setPreferences(next);
    try {localStorage.setItem(preferencesKey, JSON.stringify(next));} catch {}
  }
  function updateRange(edge: 'start' | 'end', value: number) {
    if (!Number.isInteger(value)) return;
    const {range, rangeEnd} = preferences;
    const next = edge === 'start' ? Math.min(allTime, Math.max(rangeEnd, value)) : Math.min(range, allTime - 1, Math.max(today, value));
    if (next === (edge === 'start' ? range : rangeEnd)) return;
    savePreferences(current => edge === 'start' ? {...current, range: Math.max(next, current.rangeEnd)} : {...current, rangeEnd: Math.min(next, current.range)});
  }
  return {preferences, updateRange, savePreferences};
}

export function ActivityRange({start, end, now, onChange}: {start: number; end: number; now: number; onChange: (edge: 'start' | 'end', value: number) => void}) {
  const rail = useRef<HTMLDivElement>(null);
  const startInput = useRef<HTMLInputElement>(null);
  const endInput = useRef<HTMLInputElement>(null);
  const drag = useRef<{edge: 'start' | 'end'; offset: number; pointerId: number; left: number; width: number; clientX: number} | null>(null);
  const frame = useRef<number | null>(null);
  const [draft, setDraft] = useState<{edge: 'start' | 'end'; position: number} | null>(null);
  const [pointerFocus, setPointerFocus] = useState(false);
  const startPosition = draft?.edge === 'start' ? draft.position : start;
  const endPosition = draft?.edge === 'end' ? draft.position : end;
  const startStep = Math.round(startPosition);
  const endStep = Math.round(endPosition);
  const startLabel = activityDateLabel(startStep, now);
  const endLabel = activityDateLabel(endStep, now);
  const overlapping = startPosition === endPosition;

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  function dragPosition(active: NonNullable<typeof drag.current>) {
    const position = (active.clientX - active.offset - active.left) / active.width * allTime;
    return active.edge === 'start'
      ? Math.min(allTime, Math.max(end, position))
      : Math.min(start, allTime - 1, Math.max(today, position));
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || !rail.current) return;
    const {left, width} = rail.current.getBoundingClientRect();
    if (!width) return;
    const startX = left + width * start / allTime;
    const endX = left + width * end / allTime;
    const edge = event.clientX < (startX + endX) / 2 ? 'end' : 'start';
    const center = edge === 'start' ? startX : endX;
    const thumb = center + (overlapping ? (edge === 'start' ? 8 : -8) : 0);
    const grabbedThumb = Math.abs(event.clientX - thumb) <= 8;
    const active: NonNullable<typeof drag.current> = {edge, offset: grabbedThumb ? event.clientX - center : 0, pointerId: event.pointerId, left, width, clientX: event.clientX};
    drag.current = active;
    event.preventDefault();
    (edge === 'start' ? startInput : endInput).current?.focus({preventScroll: true});
    setPointerFocus(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft({edge, position: dragPosition(active)});
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (active?.pointerId !== event.pointerId) return;
    active.clientX = event.clientX;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setDraft({edge: active.edge, position: dragPosition(active)});
    });
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    const active = drag.current;
    if (active?.pointerId !== event.pointerId) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    drag.current = null;
    setDraft(null);
    if (commit) {
      active.clientX = event.clientX;
      onChange(active.edge, Math.round(dragPosition(active)));
    }
  }

  const visibleMarks = [...new Set([
    ...baseRangeMarks.filter(step =>
      step === today || step === allTime ||
      (Math.abs(step - startStep) > 1 && Math.abs(step - endStep) > 1)
    ),
    startStep,
    endStep,
  ])].sort((a, b) => a - b);

  return <div className="board-range" role="group" aria-label="活动时间">
    <div className="board-range-scale" aria-hidden="true">
      {visibleMarks.map(step => <span key={step} className="board-range-mark" data-selected={step === startStep || step === endStep}
        data-wide-only={step === 17 && step !== startStep && step !== endStep}
        data-near-start={step === today + 1 || undefined}
        data-near-end={step === allTime - 1 || undefined}
        style={{insetInlineStart: rangePosition(step)}}>
        {ranges[step]}
      </span>)}
    </div>
    <div className="board-range-control" data-overlapping={overlapping} data-pressed={draft?.edge} data-pointer-focus={pointerFocus}
      onBlur={() => setPointerFocus(false)} onKeyDown={() => setPointerFocus(false)}
      onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={event => finishDrag(event, true)}
      onPointerCancel={event => finishDrag(event, false)} onLostPointerCapture={event => finishDrag(event, false)}>
      <input ref={startInput} id="board-activity-start" type="range" min={endStep} max={allTime} value={startStep}
        aria-label="开始日期" aria-valuetext={startLabel} onChange={event => onChange('start', event.target.valueAsNumber)} />
      <input ref={endInput} id="board-activity-end" type="range" min={today} max={Math.min(startStep, allTime - 1)} value={endStep}
        aria-label="结束日期" aria-valuetext={endLabel} onChange={event => onChange('end', event.target.valueAsNumber)} />
      <div ref={rail} className="board-range-rail" aria-hidden="true"
        style={{'--range-end': rangePosition(endPosition), '--range-start': rangePosition(startPosition)} as CSSProperties}>
        <span className="board-range-selection" />
        <span className="board-range-thumb board-range-thumb-start" />
        <span className="board-range-thumb board-range-thumb-end" />
      </div>
    </div>
  </div>;
}

const stringValue = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const noteValue = (value: unknown) => typeof value === 'string' ? value : '';
const timestamp = (value: unknown) => typeof value === 'number' && value > 0 ? new Date(value).getTime() || 0 : 0;
const dateFormat = new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
export const formatBoardDateTime = (value: number) => value > 0 ? dateFormat.format(new Date(value)) : '';

function BoardTime({value, title}: {value: number; title?: string}) {
  if (!value) return <span className="board-missing">—</span>;
  const date = new Date(value);
  const exact = dateFormat.format(date);
  const label = formatRelativeStatusDate(value) || exact;
  return <time className="board-time" dateTime={date.toISOString()} title={title ? title + '：' + exact : exact}>{label}</time>;
}

function NotePreview({note}: {note: string}) {
  return <p className="board-note" title={note}>{note}</p>;
}

function NoteButton({label, name, note, onClick, disabled}: {label: string; name: string; note: string; onClick: () => void; disabled: boolean}) {
  const action = (note ? '编辑' : '添加') + label;
  return <button className="board-edit-trigger board-note-edit" type="button" title={action} aria-label={action + '：' + name}
    aria-haspopup="dialog" disabled={disabled} onClick={onClick}><NoteIcon hasNote={Boolean(note)} /></button>;
}

function matchesBoardFilter(job: BoardJob, filter: BoardFilter) {
  if (filter.column === 'favorite') {
    const matched = filter.value === 'job' ? job.favorite
      : filter.value === 'company' ? job.companyFavorite
      : filter.value === 'none' ? !job.favorite && !job.companyFavorite
      : filter.value === 'any' ? job.favorite || job.companyFavorite
      : true;
    return filter.operator === 'differs' ? !matched : matched;
  }
  const value = (filter.column === 'status' ? job.statusText : job.company).trim().toLocaleLowerCase();
  const term = filter.value.trim().toLocaleLowerCase();
  switch (filter.operator) {
    case 'empty': return value === '';
    case 'filled': return value !== '';
    case 'contains': return !term || value.includes(term);
    case 'excludes': return !term || !value.includes(term);
    case 'equals': return !term || value === term;
    case 'differs': return !term || value !== term;
  }
}

function BoardFilters({filters, onChange}: {filters: BoardFilter[]; onChange: (filters: BoardFilter[]) => void}) {
  const rows = filters.length ? filters : [emptyFilter];
  function update(index: number, fields: Partial<BoardFilter>) {
    onChange(rows.map((filter, position) => position === index ? {...filter, ...fields} : filter));
  }
  return <div id="board-filter-panel" className="board-filter-panel">
    <span id="board-filters-label">筛选</span>
    <div className="board-filter-fields" role="group" aria-labelledby="board-filters-label">
      {rows.map((filter, index) => <div className="board-filter-row" key={index}>
        <DashboardSelect label={'第 ' + (index + 1) + ' 条的筛选列'} value={filter.column} options={boardColumnOptions}
          onChange={column => update(index, column === 'favorite'
            ? {column, operator: filter.operator === 'differs' ? 'differs' : 'equals', value: 'any'}
            : {column, operator: filter.column === 'favorite' ? 'contains' : filter.operator, value: ''})} />
        {filter.column === 'favorite' ? <>
          <DashboardSelect label={'第 ' + (index + 1) + ' 条的条件'}
            value={filter.operator === 'differs' ? 'differs' : 'equals'} options={favoriteOperatorOptions}
            onChange={operator => update(index, {operator})} />
          <DashboardSelect label={'第 ' + (index + 1) + ' 条的值'}
            value={isFavoriteFilterValue(filter.value) ? filter.value : 'any'} options={favoriteFilterOptions}
            onChange={value => update(index, {value})} />
        </> : <>
          <DashboardSelect label={'第 ' + (index + 1) + ' 条的条件'} value={filter.operator} options={operatorOptions}
            onChange={operator => update(index, {operator})} />
          {filter.operator !== 'empty' && filter.operator !== 'filled' && <input aria-label={'第 ' + (index + 1) + ' 条的值'}
            placeholder={filter.column === 'status' ? '状态关键词，如面试中' : '公司名称'}
            value={filter.value} onChange={event => update(index, {value: event.target.value})} />}
        </>}
        {rows.length > 1 && <button className="board-filter-action board-filter-remove" type="button" aria-label={'移除第 ' + (index + 1) + ' 条筛选'} onClick={() => onChange(rows.filter((_, position) => position !== index))}>移除</button>}
      </div>)}
    </div>
    <div className="board-filter-actions">
      <button className="board-filter-action" type="button" onClick={() => onChange([...rows, {...emptyFilter, column: rows[0].column === 'status' ? 'company' : 'status'}])}>添加筛选</button>
      {!!filters.length && <button className="board-filter-action" type="button" onClick={() => onChange([])}>清空筛选</button>}
    </div>
  </div>;
}

const boardColumns = (edit: (target: BoardEdit) => void, busy: boolean): ColumnDef<BoardJob>[] => [
  {
    accessorKey: 'title', header: columnLabels.title,
    cell: ({row}) => {
      const job = row.original;
      const title = job.url
        ? <a className="board-job-title" href={job.url} target="_blank" rel="noreferrer" title={job.title}>{job.title}</a>
        : <span className="board-job-title" title={job.title}>{job.title}</span>;
      return <div className="board-cell-actions">
        <div className="board-job-name">
          <div className="board-name">{title}{job.favorite && <FavoriteMark kind="job" />}</div>
          {job.jobClosed && <span className="board-job-closed" title={job.jobClosedObservedAt ? '发现关闭于 ' + dateFormat.format(job.jobClosedObservedAt) : undefined}>职位已关闭</span>}
        </div>
        <button className="board-edit-trigger board-job-delete" type="button"
          title="删除职位记录" aria-label={'删除 ' + job.title} aria-haspopup="dialog" disabled={busy}
          onClick={() => edit({kind: 'job-delete', id: job.id, name: job.title, updatedAt: job.updatedAt})}>
          <Icon icon={Trash} />
        </button>
      </div>;
    },
  },
  {
    accessorKey: 'company', header: columnLabels.company,
    cell: ({row}) => {
      const {company, companyId, companyNote, companyFavorite} = row.original;
      return <>
        <div className="board-cell-actions">
          <span className="board-name">{company}{companyFavorite && <FavoriteMark kind="company" />}</span>
          {companyId && <NoteButton label="公司备注" name={company} note={companyNote} disabled={busy}
            onClick={() => edit({kind: 'company-note', id: companyId, name: company, note: companyNote})} />}
        </div>
        {companyNote && <NotePreview note={companyNote} />}
      </>;
    },
  },
  {
    id: 'latestMessage', header: columnLabels.latestMessage,
    cell: ({row}) => {
      const message = row.original.latestMessage;
      if (!message) return <span className="board-missing">—</span>;
      return <>
        <p className="board-message-text" title={message.text}>{message.text}</p>
        <p className="board-message-meta">
          <span className="board-message-sender" data-direction={message.direction} title={message.direction === 'unknown' ? '发送方向未知' : undefined}>
            {message.direction === 'in' && <Icon icon={ArrowLeft} />}
            {messageSenders[message.direction]}
            {message.direction === 'out' && <Icon icon={ArrowRight} />}
          </span>
          <MessageReceipt direction={message.direction} receipt={message.receipt} />
          <BoardTime value={message.time} title="对话消息时间" />
          {message.fromList && <span>聊天摘要</span>}
        </p>
      </>;
    },
  },
  {
    accessorKey: 'status', header: columnLabels.status,
    sortingFn: (first, second) => statusOrder.get(first.getValue('status'))! - statusOrder.get(second.getValue('status'))!,
    cell: ({row}) => {
      const {id, title, manual, manualStatus, statusText, statusAt} = row.original;
      return <>
        <button className="board-status-edit" type="button" aria-haspopup="dialog"
          aria-label={statusText + '，修改 ' + title + ' 的状态'} disabled={busy}
          onClick={() => edit({kind: 'status', id, name: title, status: statusText, manualStatus})}><span>{statusText}</span><Icon icon={ChevronDown} /></button>
        <BoardTime value={statusAt} title={manual ? '手动设置当前状态的时间' : '判断当前状态所依据的消息时间'} />
      </>;
    },
  },
  {
    id: 'detail', header: columnLabels.detail,
    cell: ({row}) => {
      const {id, title, detail, note} = row.original;
      return <div className="board-cell-actions">
        <div>
          {detail && <p className="board-status-detail">{detail}</p>}
          {note && <NotePreview note={note} />}
        </div>
        <NoteButton label="JD 备注" name={title} note={note} disabled={busy}
          onClick={() => edit({kind: 'job-note', id, name: title, note})} />
      </div>;
    },
  },
  {
    id: 'conditions', header: columnLabels.conditions,
    cell: ({row}) => row.original.conditions.length
      ? row.original.conditions.map((condition, index) => <span className="board-condition" key={index}>{condition}{index + 1 < row.original.conditions.length && ' · '}</span>)
      : <span className="board-missing">—</span>,
  },
  {
    id: 'activityAt',
    accessorFn: jobActivityTimes,
    filterFn: (row, _columnId, window: ActivityWindow) => matchesActivityWindow(row.original, window),
  },
  {accessorKey: 'statusAt', sortingFn: 'basic'},
  {
    id: 'favorite',
    accessorFn: (job): FavoriteGroup => job.favorite ? 'job' : job.companyFavorite ? 'company' : 'none',
    sortingFn: (first, second) => favoriteOrder.get(first.getValue<FavoriteGroup>('favorite'))! - favoriteOrder.get(second.getValue<FavoriteGroup>('favorite'))!,
  },
];
const boardState: Pick<TableState, 'columnVisibility'> = {
  columnVisibility: {statusAt: false, activityAt: false, favorite: false},
};

function jobActivityTimes(job: BoardJob) {
  return [job.statusAt, job.statusActivityAt, job.jobClosedObservedAt, job.latestMessage?.time ?? 0, ...job.messageActivity];
}

export function matchesActivityWindow(job: BoardJob, window: ActivityWindow | null) {
  if (!window) return true;
  return job.statusAt > 0 && jobActivityTimes(job).some(time => withinActivityWindow(time, window));
}

export function buildBoardJobs(snapshot: DatabaseSnapshot | null): BoardJob[] {
  if (!snapshot?.account) return [];
  const companies = new Map(snapshot.companies.map(company => [company.id, company]));
  return snapshot.jobs.filter(job => typeof job.id === 'string' && job.id).map(job => {
    const manualStatus = stringValue(job.manualStatus);
    const manual = Boolean(manualStatus || job.manual);
    const status = normalizeStatus(manualStatus || stringValue(job.status) || stringValue(job.autoStatus));
    const resumeLabel = !manual && status === 'resume_event' ? stringValue(job.autoLabel) : '';
    const latestMessage = job.latestMessage;
    const company = companies.get(job.companyId);
    return {
      id: job.id,
      title: stringValue(job.title) || '待识别 JD',
      company: stringValue(company?.name) || stringValue(job.companyName) || '公司待识别',
      companyId: company ? company.id : '',
      companyNote: noteValue(company?.note),
      companyFavorite: company?.favorite === true,
      favorite: job.favorite === true,
      jobClosed: job.jobClosed === true,
      jobClosedObservedAt: timestamp(job.jobClosedObservedAt),
      conditions: [job.salary, job.location, job.experience, job.degree].map(stringValue).filter(Boolean),
      status: resumeEventStage(resumeLabel) || (statusOrder.has(status) ? status : 'unknown'),
      detail: resumeLabel || (manual ? '手动设置' : ''),
      note: noteValue(job.note),
      url: jobURL(stringValue(job.url)),
      statusAt: timestamp(job.statusAt),
      statusActivityAt: timestamp(job.statusActivityAt),
      messageActivity: job.messageActivity ?? [],
      manual,
      manualStatus: manual ? normalizeStatus(manualStatus || status) : null,
      statusText: resumeLabel || statusLabel(status),
      updatedAt: typeof job.updatedAt === 'number' && Number.isFinite(job.updatedAt) ? job.updatedAt : undefined,
      latestMessage: latestMessage ? {...latestMessage, time: timestamp(latestMessage.time)} : undefined,
    };
  });
}

export function filterBoardJobs(jobs: BoardJob[], filters: BoardFilter[], window: ActivityWindow | null) {
  return jobs.filter(job => filters.every(filter => matchesBoardFilter(job, filter)) && matchesActivityWindow(job, window));
}

export interface BoardJobGroup {
  key: string;
  label: string;
  jobs: BoardJob[];
}

export function describeBoardFilters(filters: BoardFilter[]): string[] {
  const favoriteLabels = new Map<string, string>(favoriteFilterOptions.map(option => [option.value, option.label]));
  return filters.flatMap(filter => {
    const column = boardColumnLabels[filter.column];
    if (filter.column === 'favorite') {
      const operator = filter.operator === 'differs' ? filterOperators.differs : filterOperators.equals;
      return [column + ' ' + operator + '「' + (favoriteLabels.get(filter.value) || '已收藏') + '」'];
    }
    const operator = filterOperators[filter.operator];
    if (filter.operator === 'empty' || filter.operator === 'filled') return [column + ' ' + operator];
    const value = filter.value.trim();
    return value ? [column + ' ' + operator + '「' + value + '」'] : [];
  });
}

export function groupBoardJobs(jobs: BoardJob[], groupBy: BoardColumn): BoardJobGroup[] {
  const buckets = new Map<string, BoardJob[]>();
  for (const job of jobs) {
    const groupKey = groupBy === 'status' ? job.status
      : groupBy === 'favorite' ? (job.favorite ? 'job' : job.companyFavorite ? 'company' : 'none')
      : job.company;
    const list = buckets.get(groupKey);
    if (list) list.push(job);
    else buckets.set(groupKey, [job]);
  }
  const groups = [...buckets.entries()].map(([key, groupJobs]) => ({
    key,
    label: groupBy === 'status' ? statusLabel(key)
      : groupBy === 'favorite' ? favoriteGroupLabels[key as FavoriteGroup] || '未分类'
      : key || '未分类',
    jobs: [...groupJobs].sort((a, b) => (b.statusAt || 0) - (a.statusAt || 0)),
  }));
  if (groupBy === 'status') {
    groups.sort((a, b) => (statusOrder.get(a.key) ?? 999) - (statusOrder.get(b.key) ?? 999));
  } else if (groupBy === 'favorite') {
    groups.sort((a, b) => (favoriteOrder.get(a.key as FavoriteGroup) ?? 999) - (favoriteOrder.get(b.key as FavoriteGroup) ?? 999));
  } else {
    groups.sort((a, b) => a.key.localeCompare(b.key, 'zh-CN'));
  }
  return groups;
}

export function JobBoard({snapshot, busy, onSave, activityWindow, now, board}: {snapshot: DatabaseSnapshot | null; busy: boolean; onSave: (message: ExternalRecord) => Promise<void>; activityWindow: ActivityWindow | null; now: number; board: ReturnType<typeof useBoardPreferences>}) {
  const {preferences, savePreferences} = board;
  const [editor, setEditor] = useState<BoardEdit | null>(null);
  const columns = useMemo(() => boardColumns(setEditor, busy), [busy]);
  const columnFilters = useMemo(() => activityWindow ? [{id: 'activityAt', value: activityWindow}] : [], [activityWindow]);
  const data = useMemo(() => buildBoardJobs(snapshot), [snapshot]);

  const {groupBy, filters} = preferences;
  const shownJobs = useMemo(() => data.filter(job => filters.every(filter => matchesBoardFilter(job, filter))), [data, filters]);
  const tableState = useMemo(() => ({
    ...boardState,
    columnFilters,
    grouping: [groupBy],
    sorting: [{id: groupBy, desc: false}, {id: 'statusAt', desc: true}],
  }), [columnFilters, groupBy]);
  const table = useReactTable({
    data: shownJobs,
    columns,
    state: tableState,
    autoResetExpanded: false,
    autoResetPageIndex: false,
    groupedColumnMode: false,
    getRowId: job => job.id,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const groups = table.getRowModel().rows;
  const headers = table.getHeaderGroups()[0].headers;
  const count = table.getFilteredRowModel().rows.length;

  const representedCompanies = new Set(table.getFilteredRowModel().rows.map(row => row.original.companyId));
  const favoriteCompanies = snapshot?.companies.filter(company => company.favorite === true && !representedCompanies.has(company.id)) ?? [];

  return <section className="job-board" aria-labelledby="dashboard-title" aria-busy={busy}>
    <div className="board-panel">
      <div className="board-controls">
        <div className="board-group-field">
          <label htmlFor="board-group-by">分组</label>
          <DashboardSelect id="board-group-by" label="分组" value={groupBy} options={boardColumnOptions}
            onChange={column => savePreferences(current => ({...current, groupBy: column}))} />
        </div>
        <BoardFilters filters={filters} onChange={filters => savePreferences(current => ({...current, filters}))} />
        <div className="board-summary">
          <output htmlFor="board-activity-start board-activity-end">活动时间 {activityDateLabel(preferences.range, now)} 至 {activityDateLabel(preferences.rangeEnd, now)}</output>
          <span>{count === data.length ? count : count + ' / ' + data.length} 个 JD，{groups.length} 组</span>
        </div>
      </div>
      {groups.length ?
        <div className="board-table-wrap" role="region" aria-label={'JD 按' + columnLabels[groupBy] + '分组'} tabIndex={0}>
          <table className="board-table">
            <thead><tr>{headers.map(header =>
              <th key={header.id} scope="col" className={'board-col-' + header.column.id}>{flexRender(header.column.columnDef.header, header.getContext())}</th>
            )}</tr></thead>
            {groups.map((group, index) => {
              const value = group.getValue<string>(groupBy);
              const label = groupBy === 'status' ? statusLabel(value)
                : groupBy === 'favorite' ? favoriteGroupLabels[value as FavoriteGroup] || '未分类'
                : value || '未分类';
              const groupKey = groupBy === 'status' ? value : group.id;
              const headingId = groupBy === 'status' ? 'board-status-' + value
                : groupBy === 'favorite' ? 'board-favorite-' + value
                : 'board-group-' + index;
              const expanded = !preferences.collapsed.includes(groupKey);
              const toggleGroup = () => savePreferences(current => ({...current,
                collapsed: expanded ? [...new Set([...current.collapsed, groupKey])] : current.collapsed.filter(value => value !== groupKey),
              }));
              return <tbody key={group.id} className="board-group" aria-labelledby={headingId}>
                <tr className="board-group-row">
                  <th colSpan={headers.length} scope="rowgroup" onClick={event => {
                    if (!(event.target as Element | null)?.closest?.('button')) toggleGroup();
                  }}>
                    <div className="board-group-head">
                      <h2 id={headingId}>
                        <button className="board-group-toggle" type="button" aria-expanded={expanded} onClick={toggleGroup}>
                          <Icon icon={ChevronRight} /><span title={label}>{label}</span>
                        </button>
                      </h2>
                      <span className="board-count">{group.subRows.length} 个 JD</span>
                    </div>
                  </th>
                </tr>
                {expanded && group.subRows.map(row => <tr key={row.id} className="board-job-row">
                  {row.getVisibleCells().map(cell => {
                    const content = flexRender(cell.column.columnDef.cell, cell.getContext());
                    const className = 'board-col-' + cell.column.id;
                    return cell.column.id === 'title'
                      ? <th key={cell.id} scope="row" className={className}>{content}</th>
                      : <td key={cell.id} className={className}>{content}</td>;
                  })}
                </tr>)}
              </tbody>;
            })}
          </table>
        </div>
      : <div className="board-empty-wrap">
          <p className="board-empty" data-loading={busy || undefined}>
            {busy && <span className="bh-spinner"><Icon icon={Loader} /></span>}
            {busy ? '正在读取 JD…' : data.length ? '当前筛选下暂无 JD' : snapshot?.account ? '当前账号暂无 JD' : snapshot ? '暂无可用账号' : '暂时无法读取 JD'}
          </p>
          {busy && <div className="board-skeleton bh-skeleton-list" aria-hidden="true">
            <span className="bh-skeleton-bar" style={{width: '100%'}} />
            <span className="bh-skeleton-bar" style={{width: '88%'}} />
            <span className="bh-skeleton-bar" style={{width: '72%'}} />
          </div>}
        </div>}
    </div>
    {!!favoriteCompanies.length && <section className="board-favorite-companies" aria-labelledby="board-favorite-companies-title">
      <h2 id="board-favorite-companies-title">收藏公司</h2>
      <ul>{favoriteCompanies.map(company => <li className="board-name" key={company.id}>
        {company.name}<FavoriteMark kind="company" />
      </li>)}</ul>
    </section>}
    {editor && snapshot?.account && <BoardEditor target={editor} account={snapshot.account} onSave={onSave} onClose={() => setEditor(null)} />}
  </section>;
}
