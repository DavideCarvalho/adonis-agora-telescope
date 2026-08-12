import type { SVGProps } from 'react';

/** Crisp 1.6px-stroke line icons — no icon-font dependency, matching the NestJS sibling's aesthetic. */
const base = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function XIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function SearchIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function SunIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

export function MoonIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

export function RefreshIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5" />
    </svg>
  );
}

export function PlayIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <path d="M6 4l14 8-14 8z" />
    </svg>
  );
}

export function SparkleIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p} aria-hidden="true">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}
