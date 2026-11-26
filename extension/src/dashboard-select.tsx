import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import type {KeyboardEvent} from 'react';
import {Check, ChevronDown} from 'reicon';
import {Icon} from './icon.tsx';

export function DashboardSelect<Value extends string>({id, label, value, options, onChange, disabled, placeholder}: {
  id?: string;
  label: string;
  value: Value;
  options: ReadonlyArray<{value: Value; label: string}>;
  onChange: (value: Value) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const initialFocus = useRef(0);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({above: false, right: false});
  const selectedIndex = options.findIndex(option => option.value === value);

  useLayoutEffect(() => {
    if (!open) return;
    const bounds = trigger.current?.getBoundingClientRect();
    const height = list.current?.offsetHeight ?? 0;
    if (bounds) setPlacement({
      above: window.innerHeight - bounds.bottom < height + 8 && bounds.top > window.innerHeight - bounds.bottom,
      right: bounds.left + (list.current?.offsetWidth ?? 0) + 8 > window.innerWidth,
    });
    list.current?.querySelectorAll('button')[initialFocus.current]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    const dismiss = () => setOpen(false);
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);

  function show(index: number) {
    initialFocus.current = Math.max(0, index);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {event.preventDefault(); close(); return;}
    const buttons = [...(list.current?.querySelectorAll('button') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1)
      : event.key === 'ArrowUp' ? Math.max(index - 1, 0)
        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
    if (next !== null) {event.preventDefault(); buttons[next]?.focus();}
  }

  const labelText = options[selectedIndex]?.label ?? placeholder;
  return <div className="dashboard-select" ref={root} data-open={open} data-above={placement.above} data-right={placement.right}
    onBlur={event => {if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);}}>
    <button id={id} ref={trigger} className="dashboard-select-trigger" type="button" value={value} aria-label={label} aria-haspopup="listbox"
      aria-expanded={open} aria-controls={open ? listId : undefined} disabled={disabled || !options.length}
      onClick={() => {if (open) setOpen(false); else show(selectedIndex);}}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        show(selectedIndex >= 0 ? selectedIndex : event.key === 'ArrowUp' ? options.length - 1 : 0);
      }}><span title={labelText}>{labelText}</span><Icon icon={ChevronDown} /></button>
    {open && <div className="dashboard-select-list" id={listId} ref={list} role="listbox" aria-label={label} onKeyDown={navigate}>
      {options.map(option => <button key={option.value} type="button" role="option" tabIndex={-1} aria-selected={value === option.value}
        onClick={() => {close(); if (value !== option.value) onChange(option.value);}}>
        <span>{option.label}</span>{value === option.value && <Icon icon={Check} />}
      </button>)}
    </div>}
  </div>;
}
