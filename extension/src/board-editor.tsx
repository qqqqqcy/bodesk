import {useId, useState} from 'react';
import type {SubmitEvent} from 'react';
import {Loader} from 'reicon';
import {Icon} from './icon.tsx';
import {showEditorDialog, statusOptionLabel, StatusOptions} from './record-editing.tsx';
import type {ExternalRecord} from './types.ts';

export type BoardEdit = {name: string} & (
  {kind: 'company-note'; id: string; note: string} |
  {kind: 'job-note'; id: string; note: string} |
  {kind: 'status'; id: string; status: string; manualStatus: string | null}
);

export function BoardEditor({target, account, onSave, onClose}: {
  target: BoardEdit;
  account: string;
  onSave: (message: ExternalRecord) => Promise<void>;
  onClose: () => void;
}) {
  const heading = useId();
  const [note, setNote] = useState('note' in target ? target.note : '');
  const [selection, setSelection] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function cancel() {
    if (saving) return;
    if (!selection) {onClose(); return;}
    setSelection('');
    setError('');
  }

  async function save(message: ExternalRecord) {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await onSave({...message, account});
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '本地保存失败');
      setSaving(false);
    }
  }

  function saveNote(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (target.kind === 'status' || saving) return;
    if (note === target.note) {onClose(); return;}
    const fields = {note, expectedNote: target.note};
    void save(target.kind === 'company-note'
      ? {type: 'SAVE_COMPANY_NOTE', companyId: target.id, companyName: target.name, ...fields}
      : {type: 'SAVE_JOB', jobId: target.id, ...fields});
  }

  const title = target.kind === 'status' ? (selection ? '确认修改职位状态' : '修改状态')
    : target.kind === 'company-note' ? '公司备注' : 'JD 备注';

  return <dialog className="board-edit-dialog" ref={showEditorDialog} aria-labelledby={heading}
    onCancel={event => {event.preventDefault(); cancel();}}>
    <h2 id={heading}>{selection ? title : target.name + ' · ' + title}</h2>
    {target.kind === 'status' ? (selection ? <div key="confirm" className="board-edit-step">
      <p>将「{target.name}」的状态从「{target.status}」改为「{statusOptionLabel(selection)}」？</p>
      {error && <p className="board-edit-error" role="alert">{error}</p>}
      <div className="board-edit-actions">
        <button className="button" type="button" autoFocus disabled={saving} onClick={cancel}>取消</button>
        <button className="button primary" type="button" aria-busy={saving} disabled={saving}
          onClick={() => void save({type: 'SAVE_JOB', jobId: target.id, status: selection, expectedManualStatus: target.manualStatus})}>
          {saving ? <><span className="bh-spinner"><Icon icon={Loader} /></span>正在保存…</> : '确认修改'}
        </button>
      </div>
    </div> : <div key="pick" className="board-edit-step">
      <StatusOptions current={target.manualStatus ?? 'auto'} onSelect={setSelection} />
      <div className="board-edit-actions"><button className="button" type="button" onClick={onClose}>关闭</button></div>
    </div>) : <form onSubmit={saveNote}>
      <textarea aria-labelledby={heading} rows={5} maxLength={10000} autoFocus disabled={saving}
        value={note} onChange={event => setNote(event.target.value)} />
      {error && <p className="board-edit-error" role="alert">{error}</p>}
      <div className="board-edit-actions">
        <button className="button" type="button" disabled={saving} onClick={onClose}>取消</button>
        <button className="button primary" type="submit" aria-busy={saving} disabled={saving}>{saving ? <><span className="bh-spinner"><Icon icon={Loader} /></span>正在保存…</> : '保存备注'}</button>
      </div>
    </form>}
  </dialog>;
}
