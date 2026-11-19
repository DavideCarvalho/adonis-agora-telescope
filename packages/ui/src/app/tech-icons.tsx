import {
  siCloudflare,
  siGooglecloudstorage,
  siMailgun,
  siMariadb,
  siMinio,
  siMongodb,
  siMysql,
  siPostgresql,
  siRedis,
  siResend,
  siSqlite,
  siStripe,
  siUpstash,
} from 'simple-icons';

/** A technology as the Architecture page draws it. */
export interface TechStyle {
  /** Display name. */
  name: string;
  /** What kind of thing it is, for the caption. */
  kind: string;
  /** A Simple Icons path (24×24), or `null` for a drawn glyph. */
  path: string | null;
  /** Brand colour (`#rrggbb`), or `null` to use the theme's text colour. */
  hex: string | null;
  glyph?: 'bucket' | 'folder' | 'mail' | 'database' | 'server';
}

const brand = (icon: { path: string; hex: string }, name: string, kind: string): TechStyle => ({
  name,
  kind,
  path: icon.path,
  hex: `#${icon.hex}`,
});

const TECH: Record<string, TechStyle> = {
  postgres: brand(siPostgresql, 'PostgreSQL', 'database'),
  mysql: brand(siMysql, 'MySQL', 'database'),
  mariadb: brand(siMariadb, 'MariaDB', 'database'),
  sqlite: brand(siSqlite, 'SQLite', 'database'),
  mongodb: brand(siMongodb, 'MongoDB', 'database'),
  redis: brand(siRedis, 'Redis', 'cache & queues'),
  upstash: brand(siUpstash, 'Upstash', 'Redis'),
  minio: brand(siMinio, 'MinIO', 'object storage'),
  r2: brand(siCloudflare, 'Cloudflare R2', 'object storage'),
  gcs: brand(siGooglecloudstorage, 'Cloud Storage', 'object storage'),
  resend: brand(siResend, 'Resend', 'email'),
  mailgun: brand(siMailgun, 'Mailgun', 'email'),
  stripe: brand(siStripe, 'Stripe', 'payments'),
  s3: { name: 'S3', kind: 'object storage', path: null, hex: '#E25444', glyph: 'bucket' },
  fs: { name: 'Disk', kind: 'files', path: null, hex: null, glyph: 'folder' },
  smtp: { name: 'SMTP', kind: 'email', path: null, hex: null, glyph: 'mail' },
  ses: { name: 'SES', kind: 'email', path: null, hex: '#DD344C', glyph: 'mail' },
};

/** How `tech` is drawn; an unknown one gets a neutral server glyph and its own name. */
export function techStyle(tech: string): TechStyle {
  return TECH[tech] ?? { name: tech, kind: 'service', path: null, hex: null, glyph: 'server' };
}

/** Very dark brand colours (Resend is black) would vanish on a dark panel: use the text colour. */
function readable(hex: string | null): string {
  if (hex === null) return 'var(--color-fg)';
  const n = Number.parseInt(hex.slice(1), 16);
  const luminance = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  if (luminance < 40) return 'var(--color-fg)';
  // Mid-dark brands (PostgreSQL's blue) lose contrast on a dark panel: pull them towards the text
  // colour, which lightens them in dark mode and leaves them close to the brand in light mode.
  return luminance < 120 ? `color-mix(in oklab, ${hex} 70%, var(--color-fg))` : hex;
}

const GLYPHS: Record<NonNullable<TechStyle['glyph']>, string> = {
  // Simple outlined shapes on a 24×24 grid, stroked.
  bucket: 'M4 6h16l-2 14H6L4 6zM4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z',
  folder:
    'M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
  mail: 'M3.5 6h17v12h-17zM3.5 6.5 12 13l8.5-6.5',
  database:
    'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3zM4 6c0 1.7 3.6 3 8 3s8-1.3 8-3M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01',
};

/** The logo (or glyph) of `tech`, `size` px square. */
export function TechIcon({ tech, size = 22 }: { tech: string; size?: number }) {
  const style = techStyle(tech);
  const color = readable(style.hex);
  if (style.path !== null) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={style.name}>
        <path d={style.path} fill={color} />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={style.name}
      fill="none"
      stroke={color}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={GLYPHS[style.glyph ?? 'server']} />
    </svg>
  );
}
