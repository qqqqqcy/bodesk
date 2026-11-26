import type {IconFunction} from 'reicon/createIcon';

export function Icon({icon, filled = false}: {icon: IconFunction; filled?: boolean}) {
  return <span className="bh-icon" aria-hidden="true" dangerouslySetInnerHTML={{__html: icon.toSvg({
    size: 18, strokeWidth: 1.5, weight: filled ? 'Filled' : 'Outline', attrs: {'aria-hidden': 'true', focusable: 'false'},
  })}} />;
}
