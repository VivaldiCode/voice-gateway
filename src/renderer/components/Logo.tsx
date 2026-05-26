import type { SVGProps } from 'react';

/**
 * Voice Gateway logo, inlined as SVG so it scales freely and never produces
 * a network request. Mirrors `resources/icon.svg` exactly — the Pillow
 * generator in `resources/_render-icon.py` produces the same artwork as
 * raster for the desktop bundle and tray.
 *
 * Use `size` for square dimensions. `wordmark` adds the project name to the
 * right (handy in the wizard / header).
 */
export interface LogoProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
  /** Render the project name next to the mark. */
  wordmark?: boolean;
  /** Optional subtitle under the wordmark. */
  tagline?: string;
}

export function Logo({
  size = 48,
  wordmark = false,
  tagline,
  className,
  ...rest
}: LogoProps): JSX.Element {
  if (!wordmark) {
    return <LogoMark size={size} className={className} {...rest} />;
  }
  // Issue #26 — in the wordmark variant the visible `<span>Voice Gateway</span>`
  // already gives the cluster its accessible name. Marking the SVG as
  // decorative here (aria-hidden + dropped role/aria-label, via the
  // `decorative` prop) prevents screen readers from announcing
  // "Voice Gateway, Voice Gateway" twice.
  return (
    <div className={`flex items-center gap-3 ${className ?? ''}`}>
      <LogoMark size={size} decorative />
      <div className="flex flex-col leading-tight">
        <span className="text-base font-semibold tracking-tight text-white">
          Voice Gateway
        </span>
        {tagline ? <span className="text-xs text-zinc-400">{tagline}</span> : null}
      </div>
    </div>
  );
}

function LogoMark({
  size = 48,
  decorative = false,
  className,
  ...rest
}: SVGProps<SVGSVGElement> & { size?: number; decorative?: boolean }): JSX.Element {
  // When `decorative` is true (wordmark cluster, issue #26) the SVG is purely
  // visual — a sibling element carries the accessible name. We drop role +
  // aria-label and add aria-hidden so assistive tech ignores the SVG.
  // Default (`decorative=false`) keeps the icon-only variant labeled — without
  // a wordmark sibling, the SVG IS the accessible name.
  const a11yProps = decorative
    ? ({ 'aria-hidden': true as const } as const)
    : ({ role: 'img' as const, 'aria-label': 'Voice Gateway' } as const);
  return (
    <svg
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      {...a11yProps}
      className={className}
      {...rest}
    >
      <defs>
        <linearGradient id="vg-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#a48bff" />
          <stop offset="100%" stopColor="#5a3ec7" />
        </linearGradient>
        <radialGradient id="vg-logo-orb" cx="50%" cy="42%" r="55%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="80%" stopColor="#eee7ff" />
          <stop offset="100%" stopColor="#dad0ff" />
        </radialGradient>
      </defs>
      <rect width="1024" height="1024" rx="225" ry="225" fill="url(#vg-logo-bg)" />
      <circle cx="512" cy="512" r="390" fill="#ffffff" fillOpacity="0.06" />
      <circle cx="512" cy="512" r="320" fill="#ffffff" fillOpacity="0.10" />
      <circle cx="512" cy="512" r="282" fill="url(#vg-logo-orb)" />
      <g fill="#5a3ec7">
        <rect x="422" y="442" width="50" height="140" rx="25" />
        <rect x="487" y="362" width="50" height="300" rx="25" />
        <rect x="552" y="442" width="50" height="140" rx="25" />
      </g>
    </svg>
  );
}
