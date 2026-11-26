import {statusLabel} from './status.ts';

const statusOptions = ['auto', 'awaiting_self', 'awaiting_boss', 'resume_requested', 'resume_applied', 'resume_sent', 'resume_viewed', 'communication_rejected', 'interviewing', 'passed', 'failed', 'unknown'];

export const statusOptionLabel = (value: string) => value === 'auto' ? '跟随自动判断' : statusLabel(value);

export function StatusOptions({current, onSelect}: {current: string; onSelect: (status: string) => void}) {
  const options = statusOptions.includes(current) ? statusOptions : [...statusOptions, current];
  const firstChoice = options.find(option => option !== current);
  return <div className="bh-status-picker">
    {options.map(option => <button className="bh-status-option" type="button" key={option} value={option}
      disabled={option === current} autoFocus={option === firstChoice} onClick={() => onSelect(option)}>
      {statusOptionLabel(option)}{option === current && <span>当前</span>}
    </button>)}
  </div>;
}

export function showEditorDialog(dialog: HTMLDialogElement | null) {
  if (!dialog) return;
  dialog.showModal();
  return () => dialog.close();
}

export function NoteIcon({hasNote}: {hasNote: boolean}) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M13.5 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2M7 8h5M7 12h3" />
    <path d="m12 17 6.5-6.5a1.4 1.4 0 0 1 2 2L14 19l-3 1z" />
    {hasNote && <circle cx="8" cy="16" r="1" fill="currentColor" stroke="none" />}
  </svg>;
}
