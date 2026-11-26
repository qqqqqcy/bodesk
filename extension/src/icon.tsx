import {Building, Star} from 'reicon';
import type {IconFunction} from 'reicon/createIcon';

export function Icon({icon, filled = false}: {icon: IconFunction; filled?: boolean}) {
  return <span className="bh-icon" aria-hidden="true" dangerouslySetInnerHTML={{__html: icon.toSvg({
    size: 18, strokeWidth: 1.5, weight: filled ? 'Filled' : 'Outline', attrs: {'aria-hidden': 'true', focusable: 'false'},
  })}} />;
}

export function FavoriteMark({kind}: {kind: 'job' | 'company'}) {
  const company = kind === 'company';
  const label = company ? '已收藏公司' : '已收藏职位';
  return <span className="bh-favorite" role="img" aria-label={label} title={label}><Icon icon={company ? Building : Star} filled /></span>;
}
