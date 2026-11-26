import {Check, CheckRead} from 'reicon';
import {Icon} from './icon.tsx';
import type {HumanMessagePreview} from './types.ts';

export function MessageReceipt({direction, receipt}: Pick<HumanMessagePreview, 'direction' | 'receipt'>) {
  if (direction !== 'out' || !receipt) return null;
  return <span className="message-receipt" data-receipt={receipt}>
    <Icon icon={receipt === 'read' ? CheckRead : Check} />
    {receipt === 'read' ? '已读' : '已送达'}
  </span>;
}
