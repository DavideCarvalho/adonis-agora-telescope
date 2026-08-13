import type { Config } from 'tailwindcss';

/**
 * shadcn's semantic class names (`bg-background`, `text-muted-foreground`, `border-border`, …) are
 * wired here to the Aviary console tokens declared in `src/app/index.css`, NOT to shadcn's own
 * defaults. Vendored primitives under `src/app/ui/` therefore inherit the console palette with no
 * per-component theming, and flip with the `.light` root class for free.
 *
 * This is a byte-for-byte port of `@dudousxd/nestjs-telescope-ui`'s `tailwind.config.ts` (this
 * console's NestJS sibling — same product, same tokens, same `--accent` magenta) so the AdonisJS
 * dashboard matches it 1:1 rather than reinventing the palette. See `adonis-durable/packages/dashboard`
 * for the same pattern applied to a different Aviary console.
 */

/**
 * Declare a token as a colour FUNCTION so Tailwind hands the opacity modifier over instead of
 * dropping the rule.
 *
 * This is the Tailwind 3 opacity trap: a plain `'var(--panel)'` value makes `bg-panel/40` emit NO
 * CSS RULE AT ALL — not a wrong background, none — which is indistinguishable from a background
 * nobody intended. Taking the modifier here and applying it with `color-mix` keeps `bg-panel/40`,
 * `border-line/60` and friends working.
 */
function token(name: string) {
  return ({ opacityValue }: { opacityValue?: string | undefined }): string =>
    opacityValue === undefined
      ? `var(${name})`
      : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`;
}

export default {
  content: ['./index.html', './src/app/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        /*
         * nestjs-telescope-ui runs the WHOLE console (headers, labels, tables, nav — not just
         * numeric/code values) in monospace: a `font-mono` class on the shell's root div, which
         * every descendant inherits. `sans` is pointed at the same stack too, as a safety net for
         * any element that ends up on the (otherwise unused) default font family.
         */
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        sans: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        // Aviary tokens, addressable directly.
        panel: token('--panel'),
        'panel-2': token('--panel-2'),
        line: token('--line'),
        'line-soft': token('--line-soft'),
        good: token('--good'),
        warn: token('--warn'),
        bad: token('--bad'),
        live: token('--live'),

        // The brand hue. Deliberately NOT called `accent`: shadcn's `accent` is a muted HOVER
        // SURFACE, and wiring it to `--accent` puts solid brand-coloured blocks under every hover.
        brand: { DEFAULT: token('--accent'), foreground: token('--bg') },

        // shadcn's semantic names, mapped per the Aviary token table. Three of these are traps
        // because the two vocabularies reuse the same word:
        //   - shadcn `accent` is a subtle HOVER SURFACE, not the brand hue.
        //   - shadcn `muted` is a SURFACE; Aviary `--muted` is dim TEXT, hence `muted-foreground`.
        border: token('--line'),
        input: token('--line'),
        ring: token('--accent'),
        background: token('--bg'),
        foreground: token('--text'),
        primary: { DEFAULT: token('--accent'), foreground: token('--bg') },
        secondary: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        muted: { DEFAULT: token('--panel-2'), foreground: token('--muted') },
        accent: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        destructive: { DEFAULT: token('--bad'), foreground: token('--bg') },
        popover: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        card: { DEFAULT: token('--panel'), foreground: token('--text') },
      },
    },
  },
  plugins: [],
} satisfies Config;
