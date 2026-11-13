import type { ReactNode, SVGProps } from 'react';

/**
 * Telescope's own 16px stroke glyphs for the sidebar and page chrome, drawn like the kit's
 * (`agora-kit/icons.tsx`): 16×16 viewBox, 1.6 stroke, currentColor. The chrome icons every console
 * shares (search, sun/moon, refresh, alert…) come from the kit.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function stroke(paths: ReactNode) {
  // biome-ignore lint/correctness/noComponentHookFactories: a static icon table built once at module load, no hooks inside
  return function Icon({ size = 16, ...props }: IconProps) {
    return (
      <svg
        viewBox="0 0 16 16"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

/** The console mark: the kit's telescope glyph, redrawn on the 16px grid. */
export const TelescopeMark = stroke(
  <>
    <path d="m2.5 9.5 8.5-4 1.5 2.8-8.5 4z" />
    <path d="m6.5 11 1.3 3.2M9.4 10.4 8 14.2M11.8 5l.6-2 2 .8-.6 2" />
  </>,
);

export const OverviewIcon = stroke(
  <>
    <rect x="2" y="2" width="5" height="5" rx="1" />
    <rect x="9" y="2" width="5" height="3" rx="1" />
    <rect x="9" y="7" width="5" height="7" rx="1" />
    <rect x="2" y="9" width="5" height="5" rx="1" />
  </>,
);
export const PulseIcon = stroke(<path d="M1.5 8.5h2.8l1.6-4 2.4 8 2-5.5 1.2 1.5h3" />);
export const ExceptionIcon = stroke(
  <>
    <path d="M8 1.8 14.5 13.5h-13z" />
    <path d="M8 6.2v3.3M8 11.6v.1" />
  </>,
);
export const EntriesIcon = stroke(
  <>
    <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
    <path d="M2.5 4h.1M2.5 8h.1M2.5 12h.1" />
  </>,
);
export const TracesIcon = stroke(<path d="M2 3.5h7M4 7h8M6 10.5h5M3 14h11" />);
export const ScreensIcon = stroke(
  <>
    <rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.3" />
    <path d="M5.5 14h5M8 11v3" />
  </>,
);
export const AiIcon = stroke(
  <>
    <path d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4" />
    <path d="M8 5.2 9 7l1.8 1L9 9l-1 1.8L7 9 5.2 8 7 7z" />
  </>,
);
export const FlameIcon = stroke(
  <path d="M8 14.2c-2.6 0-4.4-1.8-4.4-4.2 0-2.9 2.6-3.9 2.9-7.2 1.9 1.1 2.4 2.9 2.2 4.4.7-.4 1.2-1.1 1.4-2 1.4 1.2 2.3 2.8 2.3 4.6 0 2.6-1.8 4.4-4.4 4.4z" />,
);
export const QueueIcon = stroke(
  <>
    <path d="M8 1.8 14 5 8 8.2 2 5z" />
    <path d="m2 8 6 3.2L14 8M2 11l6 3.2 6-3.2" />
  </>,
);
export const ClockIcon = stroke(
  <>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.8V8l2.2 1.4" />
  </>,
);
export const ExportIcon = stroke(
  <>
    <path d="M8 2v8M4.8 6.8 8 10l3.2-3.2" />
    <path d="M2.5 11.5v1.2c0 .7.6 1.3 1.3 1.3h8.4c.7 0 1.3-.6 1.3-1.3v-1.2" />
  </>,
);
export const DashboardIcon = stroke(
  <>
    <rect x="2" y="2" width="12" height="12" rx="1.5" />
    <path d="M5 11V8.5M8 11V5.5M11 11V7" />
  </>,
);
export const PlayIcon = stroke(<path d="M4.5 2.8v10.4L13 8z" />);
export const ArrowLeftIcon = stroke(<path d="M13 8H3M7 4 3 8l4 4" />);
export const ExternalIcon = stroke(
  <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3.2c0 .5-.4.8-.8.8H3.3c-.5 0-.8-.3-.8-.8V4.8c0-.4.3-.8.8-.8h3.2" />,
);
