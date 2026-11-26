import type {HumanMessagePreview} from './types.ts';

export function MessageReceipt({direction, receipt}: Pick<HumanMessagePreview, 'direction' | 'receipt'>) {
  if (direction !== 'out' || !receipt) return null;
  return <span className="message-receipt" data-receipt={receipt}>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={receipt === 'read' ? 'm1.5 8 2.75 2.75 5.5-5.5m-3 5 0.5 0.5 5.5-5.5' : 'm3 8 3.25 3.25 6.5-6.5'} />
    </svg>
    {receipt === 'read' ? '已读' : '已送达'}
  </span>;
}
