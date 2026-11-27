import {useId, useState} from 'react';
import type {SubmitEvent} from 'react';
import {Loader} from 'reicon';
import {maxBackupBytes} from './backup.ts';
import {Icon} from './icon.tsx';
import {showEditorDialog} from './record-editing.tsx';

export function PasteImportDialog({onImport, onClose}: {
  onImport: (json: string) => Promise<void>;
  onClose: () => void;
}) {
  const heading = useId();
  const description = useId();
  const [json, setJson] = useState('');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (importing) return;
    const trimmed = json.trim();
    if (!trimmed) {
      setError('请先粘贴 JSON 内容');
      return;
    }
    if (trimmed.length > maxBackupBytes) {
      setError('粘贴的 JSON 内容不能超过 32 MB');
      return;
    }
    setImporting(true);
    setError('');
    try {
      await onImport(trimmed);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '导入失败，请检查 JSON 内容');
      setImporting(false);
    }
  }

  return <dialog className="board-edit-dialog backup-import-dialog" ref={showEditorDialog}
    aria-labelledby={heading} aria-describedby={description}
    onCancel={event => {event.preventDefault(); if (!importing) onClose();}}>
    <h2 id={heading}>粘贴 JSON 导入</h2>
    <p id={description}>粘贴 BoDesk 导出的 JSON 内容，已有记录会自动跳过。</p>
    <form onSubmit={submit}>
      <textarea aria-labelledby={heading} aria-describedby={description} rows={10} autoFocus spellCheck={false}
        disabled={importing} placeholder="在此粘贴 BoDesk 导出的 JSON 内容…"
        value={json} onChange={event => setJson(event.target.value)} />
      {error && <p className="board-edit-error" role="alert">{error}</p>}
      <div className="board-edit-actions">
        <button className="button" type="button" disabled={importing} onClick={onClose}>取消</button>
        <button className="button primary" type="submit" aria-busy={importing} disabled={importing}>
          {importing ? <><span className="bh-spinner"><Icon icon={Loader} /></span>导入中…</> : '确认导入'}
        </button>
      </div>
    </form>
  </dialog>;
}
