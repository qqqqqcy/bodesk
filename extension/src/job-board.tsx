import {useMemo, useState} from 'react';
import {flexRender, getCoreRowModel, getFilteredRowModel, getGroupedRowModel, getSortedRowModel, useReactTable} from '@tanstack/react-table';
import type {ColumnDef, TableState} from '@tanstack/react-table';
import {BoardEditor} from './board-editor.tsx';
import type {BoardEdit} from './board-editor.tsx';
import {resumeEventStage} from './core.ts';
import {NoteIcon} from './record-editing.tsx';
import {jobURL, normalizeStatus, statusLabel} from './status.ts';
import type {DatabaseSnapshot, ExternalRecord, TimedHumanMessagePreview} from './types.ts';
import {MessageReceipt} from './message-receipt.tsx';

const statusOrder = new Map([
  'passed', 'interviewing', 'failed', 'resume_viewed', 'resume_sent', 'resume_applied', 'resume_event',
  'resume_requested', 'awaiting_self', 'awaiting_boss', 'communication_rejected',
  'greeting_read', 'greeting_unread', 'read', 'unread', 'unknown',
].map((status, index) => [status, index]));

interface BoardJob {
  id: string;
  title: string;
  company: string;
  companyId: string;
  companyNote: string;
  conditions: string[];
  status: string;
  detail: string;
  note: string;
  url: string;
  statusAt: number;
  statusActivityAt: number;
  manual: boolean;
  manualStatus: string | null;
  statusText: string;
  latestMessage?: TimedHumanMessagePreview;
}

interface BoardPreferences {
  range: number;
  collapsed: string[];
}

const today = 0;
const ranges = ['当天', ...Array.from({length: 15}, (_, index) => (index + 1) + ' 天'), '1 个月', '2 个月', '3 个月', '不限'];
const allTime = ranges.length - 1;
const rangeMarks = [today, 1, 5, 10, 15, 16, 17, 18, allTime];
const preferencesKey = 'boss-helper.jd-board.preferences';
const defaultPreferences: BoardPreferences = {range: allTime, collapsed: []};
const senders = {in: '对方', out: '自己', unknown: '方向未知'};

function readPreferences(fallback = defaultPreferences): BoardPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(preferencesKey) ?? 'null');
    if (!stored) return fallback;
    const {range, collapsed} = stored;
    return {
      range: Number.isInteger(range) && range >= today && range <= allTime ? range : fallback.range,
      collapsed: Array.isArray(collapsed) ? collapsed.filter(status => typeof status === 'string' && statusOrder.has(status)) : fallback.collapsed,
    };
  } catch {return fallback;}
}

function rangeStart(range: number, now: number) {
  if (range === today) return new Date(now).setHours(0, 0, 0, 0);
  if (range <= 15) return now - range * 86400000;
  const start = new Date(now);
  const day = start.getDate();
  start.setDate(1);
  start.setMonth(start.getMonth() - (range - 15));
  start.setDate(Math.min(day, new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate()));
  return start.getTime();
}

const stringValue = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const noteValue = (value: unknown) => typeof value === 'string' ? value : '';
const timestamp = (value: unknown) => typeof value === 'number' && value > 0 ? new Date(value).getTime() || 0 : 0;
const dateFormat = new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});

function BoardTime({value, title}: {value: number; title?: string}) {
  if (!value) return <span className="board-missing">—</span>;
  const date = new Date(value);
  return <time dateTime={date.toISOString()} title={title}>{dateFormat.format(date)}</time>;
}

function NotePreview({note}: {note: string}) {
  return <details className="board-note">
    <summary>
      <span className="board-note-preview">{note}</span>
      <span className="board-note-close">收起备注</span>
    </summary>
    <p>{note}</p>
  </details>;
}

function NoteButton({label, name, note, onClick, disabled}: {label: string; name: string; note: string; onClick: () => void; disabled: boolean}) {
  const action = (note ? '编辑' : '添加') + label;
  return <button className="board-edit-trigger board-note-edit" type="button" title={action} aria-label={action + '：' + name}
    aria-haspopup="dialog" disabled={disabled} onClick={onClick}><NoteIcon hasNote={Boolean(note)} /></button>;
}

const boardColumns = (edit: (target: BoardEdit) => void, busy: boolean): ColumnDef<BoardJob>[] => [
  {
    accessorKey: 'title', header: '职位',
    cell: ({row}) => {
      const job = row.original;
      return job.url
        ? <a className="board-job-title" href={job.url} target="_blank" rel="noreferrer" title={job.title}>{job.title}</a>
        : <span className="board-job-title" title={job.title}>{job.title}</span>;
    },
  },
  {
    accessorKey: 'company', header: '公司',
    cell: ({row}) => {
      const {company, companyId, companyNote} = row.original;
      return <>
        <div className="board-cell-actions">
          <span>{company}</span>
          {companyId && <NoteButton label="公司备注" name={company} note={companyNote} disabled={busy}
            onClick={() => edit({kind: 'company-note', id: companyId, name: company, note: companyNote})} />}
        </div>
        {companyNote && <NotePreview note={companyNote} />}
      </>;
    },
  },
  {
    id: 'latestMessage', header: '最后一条对话',
    cell: ({row}) => {
      const message = row.original.latestMessage;
      if (!message) return <span className="board-missing">—</span>;
      return <>
        <p className="board-message-text" title={message.text}>{message.text}</p>
        <p className="board-message-meta">
          <span className="board-message-sender" data-direction={message.direction}>
            {message.direction !== 'unknown' && <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 8h10.75m-4-4 4 4-4 4" />
            </svg>}
            {senders[message.direction]}
          </span>
          <MessageReceipt direction={message.direction} receipt={message.receipt} />
          <BoardTime value={message.time} title="对话消息时间" />
          {message.fromList && <span>聊天摘要</span>}
        </p>
      </>;
    },
  },
  {
    accessorKey: 'statusAt', header: '状态时间', sortingFn: 'basic',
    cell: ({getValue, row}) => {
      const {id, title, manual, manualStatus, statusText} = row.original;
      return <>
        <BoardTime value={getValue<number>()} title={manual ? '手动设置当前状态的时间' : '判断当前状态所依据的消息时间'} />
        <button className="board-edit-trigger board-status-edit" type="button" aria-haspopup="dialog"
          aria-label={'修改状态：' + title} disabled={busy}
          onClick={() => edit({kind: 'status', id, name: title, status: statusText, manualStatus})}>修改状态</button>
      </>;
    },
  },
  {
    id: 'detail', header: '状态说明与备注',
    cell: ({row}) => {
      const {id, title, detail, note} = row.original;
      return <>
        <div className="board-cell-actions">
          <span className="board-status-detail">{detail}</span>
          <NoteButton label="JD 备注" name={title} note={note} disabled={busy}
            onClick={() => edit({kind: 'job-note', id, name: title, note})} />
        </div>
        {note && <NotePreview note={note} />}
      </>;
    },
  },
  {
    accessorKey: 'conditions', header: '职位条件',
    cell: ({row}) => row.original.conditions.join(' · ') || <span className="board-missing">—</span>,
  },
  {
    id: 'activityAt',
    accessorFn: job => [job.statusAt, job.statusActivityAt, job.latestMessage?.time ?? 0],
    filterFn: (row, columnId, [start, end]: [number, number]) => row.getValue<number[]>(columnId).some(time => time >= start && time <= end),
  },
  {accessorKey: 'status', sortingFn: (first, second) =>
    statusOrder.get(first.getValue('status'))! - statusOrder.get(second.getValue('status'))!},
];
const boardState: Pick<TableState, 'grouping' | 'sorting' | 'columnVisibility'> = {
  grouping: ['status'],
  sorting: [{id: 'status', desc: false}, {id: 'statusAt', desc: true}],
  columnVisibility: {status: false, activityAt: false},
};

export function JobBoard({snapshot, busy, onSave}: {snapshot: DatabaseSnapshot | null; busy: boolean; onSave: (message: ExternalRecord) => Promise<void>}) {
  const [preferences, setPreferences] = useState(readPreferences);
  const [editor, setEditor] = useState<BoardEdit | null>(null);
  const columns = useMemo(() => boardColumns(setEditor, busy), [busy]);
  function savePreferences(update: (current: BoardPreferences) => BoardPreferences) {
    const next = update(readPreferences(preferences));
    setPreferences(next);
    try {localStorage.setItem(preferencesKey, JSON.stringify(next));} catch {}
  }

  const range = preferences.range;
  const rangeLabel = range === today || range === allTime ? ranges[range] : '最近 ' + ranges[range];
  const columnFilters = useMemo(() => {
    if (range === allTime) return [];
    const now = Date.now();
    return [{id: 'activityAt', value: [rangeStart(range, now), now]}];
  }, [range, snapshot]);
  const data = useMemo(() => {
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
        conditions: [job.salary, job.location, job.experience, job.degree].map(stringValue).filter(Boolean),
        status: resumeEventStage(resumeLabel) || (statusOrder.has(status) ? status : 'unknown'),
        detail: resumeLabel || (manual ? '手动设置' : ''),
        note: noteValue(job.note),
        url: jobURL(stringValue(job.url)),
        statusAt: timestamp(job.statusAt),
        statusActivityAt: timestamp(job.statusActivityAt),
        manual,
        manualStatus: manual ? normalizeStatus(manualStatus || status) : null,
        statusText: resumeLabel || statusLabel(status),
        latestMessage: latestMessage ? {...latestMessage, time: timestamp(latestMessage.time)} : undefined,
      };
    });
  }, [snapshot]);

  const table = useReactTable({
    data,
    columns,
    state: {...boardState, columnFilters},
    getRowId: job => job.id,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const groups = table.getRowModel().rows;
  const headers = table.getHeaderGroups()[0].headers;
  const count = table.getFilteredRowModel().rows.length;

  return <section className="job-board" aria-labelledby="dashboard-title" aria-busy={busy}>
    <div className="board-range">
      <div className="board-range-heading">
        <label htmlFor="board-activity-range">活动时间</label>
        <output htmlFor="board-activity-range">{rangeLabel}</output>
      </div>
      <div className="board-range-scale" aria-hidden="true">
        {rangeMarks.map(step => <span key={step} className="board-range-mark" data-selected={step === range}
          data-wide-only={step === 1 || (step > 15 && step < allTime)} style={{insetInlineStart: (step / allTime) * 100 + '%'}}>
          {ranges[step]}
        </span>)}
      </div>
      <input id="board-activity-range" type="range" min={today} max={allTime} step="1" value={range}
        aria-valuetext={rangeLabel}
        onChange={event => {
          const nextRange = event.target.valueAsNumber;
          savePreferences(current => ({...current, range: nextRange}));
        }} />
    </div>
    {groups.length ? <>
      <p className="board-summary">{count === data.length ? count : count + ' / ' + data.length} 个 JD，{groups.length} 种状态 <span>推进较深的状态在上方</span></p>
      <div className="board-table-wrap" role="region" aria-label="JD 状态分组" tabIndex={0}>
        <table className="board-table">
          <thead><tr>{headers.map(header =>
            <th key={header.id} scope="col" className={'board-col-' + header.column.id}>{flexRender(header.column.columnDef.header, header.getContext())}</th>
          )}</tr></thead>
          {groups.map(group => {
            const status = group.getValue<string>('status');
            const expanded = !preferences.collapsed.includes(status);
            return <tbody key={group.id} className="board-group" aria-labelledby={'board-status-' + status}>
              <tr className="board-group-row">
                <th colSpan={headers.length} scope="rowgroup">
                  <div className="board-group-head">
                    <h2 id={'board-status-' + status}>
                      <button className="board-group-toggle" type="button" aria-expanded={expanded} onClick={() => savePreferences(current => ({...current,
                        collapsed: expanded ? [...new Set([...current.collapsed, status])] : current.collapsed.filter(value => value !== status),
                      }))}>
                        {statusLabel(status)}
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
    </> : <p className="board-empty">{busy ? '正在读取 JD…' : data.length ? '这段时间内暂无状态或对话更新的 JD' : snapshot?.account ? '当前账号暂无 JD' : snapshot ? '暂无可用账号' : '暂时无法读取 JD'}</p>}
    {editor && snapshot?.account && <BoardEditor target={editor} account={snapshot.account} onSave={onSave} onClose={() => setEditor(null)} />}
  </section>;
}
