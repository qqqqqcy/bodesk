interface Position {
  left: number;
  top: number;
}

const keyboardOffsets: Record<string, Position> = {
  ArrowLeft: {left: -16, top: 0},
  ArrowRight: {left: 16, top: 0},
  ArrowUp: {left: 0, top: -16},
  ArrowDown: {left: 0, top: 16},
};

export function attachWidgetDragHandle(handle: HTMLElement | null) {
  const widget = handle?.closest<HTMLElement>('#boss-local-helper-widget');
  if (!handle || !widget) return;
  const panel = widget;
  const grip = handle;
  const storageKey = 'bossHelper.widgetPosition:' + location.origin;
  let position: Position | undefined;
  let drag: {pointerId: number; startX: number; startY: number; start: Position; moved: boolean} | undefined;
  let disposed = false;

  function place(target: Position): Position {
    const {width, height} = panel.getBoundingClientRect();
    const {clientWidth, clientHeight} = document.documentElement;
    const left = Math.max(0, Math.min(target.left, clientWidth - width));
    const top = Math.max(0, Math.min(target.top, clientHeight - height));
    Object.assign(panel.style, {left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto'});
    return {left, top};
  }

  function keepInView() {
    if (position) place(position);
  }

  async function restore() {
    try {
      const saved = (await chrome.storage?.local.get(storageKey))?.[storageKey] as Position | undefined;
      if (disposed || drag || position || !saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;
      position = {left: saved.left, top: saved.top};
      keepInView();
    } catch {}
  }

  async function save() {
    try {await chrome.storage?.local.set({[storageKey]: position});} catch {}
  }

  function startDrag(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || drag) return;
    const {left, top} = panel.getBoundingClientRect();
    drag = {pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, start: {left, top}, moved: false};
    grip.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const offsetX = event.clientX - drag.startX;
    const offsetY = event.clientY - drag.startY;
    if (!drag.moved && offsetX === 0 && offsetY === 0) return;
    drag.moved = true;
    position = place({left: drag.start.left + offsetX, top: drag.start.top + offsetY});
  }

  function endDrag(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) void save();
    drag = undefined;
  }

  function moveWithKeyboard(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || drag) return;
    if (!Object.hasOwn(keyboardOffsets, event.key)) return;
    const offset = keyboardOffsets[event.key];
    event.preventDefault();
    const {left, top} = panel.getBoundingClientRect();
    position = place({left: left + offset.left, top: top + offset.top});
    void save();
  }

  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(keepInView);
  observer?.observe(panel, {box: 'border-box'});
  window.addEventListener('resize', keepInView);
  grip.addEventListener('pointerdown', startDrag);
  grip.addEventListener('pointermove', moveDrag);
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  grip.addEventListener('lostpointercapture', endDrag);
  grip.addEventListener('keydown', moveWithKeyboard);
  void restore();

  return () => {
    disposed = true;
    observer?.disconnect();
    window.removeEventListener('resize', keepInView);
    grip.removeEventListener('pointerdown', startDrag);
    grip.removeEventListener('pointermove', moveDrag);
    grip.removeEventListener('pointerup', endDrag);
    grip.removeEventListener('pointercancel', endDrag);
    grip.removeEventListener('lostpointercapture', endDrag);
    grip.removeEventListener('keydown', moveWithKeyboard);
  };
}
