import {NoteText} from 'reicon';
import {Icon} from './icon.tsx';
import {statusLabel} from './status.ts';

const statusOptions = ['auto', 'awaiting_self', 'awaiting_boss', 'resume_requested', 'resume_applied', 'resume_sent', 'resume_viewed', 'communication_rejected', 'interviewing', 'passed', 'failed', 'unknown'];

export const statusOptionLabel = (value: string) => value === 'auto' ? '跟随自动判断' : statusLabel(value);

export function StatusOptions({current, onSelect}: {current: string; onSelect: (status: string) => void}) {
  const options = statusOptions.includes(current) ? statusOptions : [...statusOptions, current];
  const firstChoice = options.find(option => option !== current);
  return <div className="bh-status-picker">
    {options.map(option => <button className="bh-status-option" type="button" key={option} value={option}
      aria-current={option === current ? 'true' : undefined} disabled={option === current}
      autoFocus={option === firstChoice} onClick={() => onSelect(option)}>
      {statusOptionLabel(option)}
    </button>)}
  </div>;
}

export function showEditorDialog(dialog: HTMLDialogElement | null) {
  if (!dialog) return;
  dialog.showModal();
  return () => dialog.close();
}

export function NoteIcon({hasNote}: {hasNote: boolean}) {
  return <Icon icon={NoteText} filled={hasNote} />;
}
