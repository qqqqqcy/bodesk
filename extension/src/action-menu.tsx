import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import type {KeyboardEvent, ReactNode} from 'react';
import {ChevronDown} from 'reicon';
import type {IconFunction} from 'reicon/createIcon';
import {Icon} from './icon.tsx';

export interface ActionMenuItem {
  id: string;
  label: string;
  icon?: IconFunction;
  disabled?: boolean;
  onSelect: () => void;
}

export interface ActionMenuSection {
  id: string;
  title?: string;
  items: ReadonlyArray<ActionMenuItem>;
}

export function ActionMenu({id, label, menuLabel, busy, disabled, hint, items, sections}: {
  id: string;
  label: ReactNode;
  menuLabel: string;
  busy?: boolean;
  disabled?: boolean;
  hint?: string;
  items?: ReadonlyArray<ActionMenuItem>;
  sections?: ReadonlyArray<ActionMenuSection>;
}) {
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<'first' | 'last'>('first');
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({above: false, right: true});
  const menuSections: ReadonlyArray<ActionMenuSection> = sections ?? (items?.length ? [{id: 'default', items}] : []);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const bounds = trigger.current?.getBoundingClientRect();
    const width = menu.current?.offsetWidth ?? 0;
    const height = menu.current?.offsetHeight ?? 0;
    if (bounds) {
      setPlacement({
        above: window.innerHeight - bounds.bottom < height + 8 && bounds.top > window.innerHeight - bounds.bottom,
        right: bounds.right >= width + 8 || bounds.left + width + 8 > window.innerWidth,
      });
    }
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
    if (buttons.length) {
      const target = initialFocus.current === 'last' ? buttons[buttons.length - 1] : buttons[0];
      target?.focus();
    } else {
      menu.current?.focus();
    }
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

  function show(target: 'first' | 'last') {
    initialFocus.current = target;
    setOpen(true);
  }

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index < 0 ? 0 : Math.min(index + 1, buttons.length - 1))
      : event.key === 'ArrowUp' ? (index < 0 ? buttons.length - 1 : Math.max(index - 1, 0))
      : event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
      : null;
    if (next !== null) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  }

  return <div className="action-menu" ref={root} data-open={open} data-above={placement.above} data-right={placement.right}
    onBlur={event => {if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);}}>
    <button id={id} ref={trigger} className="button action-menu-trigger" type="button" aria-haspopup="menu"
      aria-expanded={open} aria-controls={open ? menuId : undefined} aria-busy={busy} disabled={disabled}
      onClick={() => {if (open) setOpen(false); else show('first');}}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {event.preventDefault(); setOpen(false); return;}
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        show(event.key === 'ArrowUp' ? 'last' : 'first');
      }}>
      {label}<Icon icon={ChevronDown} />
    </button>
    {open && <div className="action-menu-list" id={menuId} ref={menu} role="menu" aria-label={menuLabel} tabIndex={-1} onKeyDown={navigate}>
      {hint && <p className="action-menu-hint" role="note">{hint}</p>}
      {menuSections.map((section, index) => {
        const titleId = section.title ? menuId + '-section-' + index : undefined;
        return <div key={section.id} className="action-menu-section" role="group" aria-labelledby={titleId}>
          {section.title && <p id={titleId} className="action-menu-section-title">{section.title}</p>}
          {section.items.map(item => <button key={item.id} id={item.id} type="button" role="menuitem" tabIndex={-1} disabled={item.disabled}
            onClick={() => {setOpen(false); item.onSelect();}}>
            {item.icon && <Icon icon={item.icon} />}
            <span>{item.label}</span>
          </button>)}
        </div>;
      })}
    </div>}
  </div>;
}
