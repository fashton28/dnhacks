import type { Config } from 'tailwindcss';

/**
 * Tailwind theme mirrors the design-system tokens (defined as CSS custom
 * properties in src/index.css). Components mostly use the CSS variables
 * directly (var(--surface-panel)) for pixel-faithfulness; these utilities
 * resolve to the SAME tokens so there are never scattered hex values.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        gray: {
          0: 'var(--gray-0)', 1: 'var(--gray-1)', 2: 'var(--gray-2)',
          3: 'var(--gray-3)', 4: 'var(--gray-4)', 5: 'var(--gray-5)',
          6: 'var(--gray-6)', 7: 'var(--gray-7)', 8: 'var(--gray-8)',
          9: 'var(--gray-9)', 10: 'var(--gray-10)', 11: 'var(--gray-11)',
          12: 'var(--gray-12)',
        },
        accent: {
          DEFAULT: 'var(--accent)', hover: 'var(--accent-hover)',
          active: 'var(--accent-active)', text: 'var(--accent-text)',
        },
        nominal: { DEFAULT: 'var(--nominal)', fg: 'var(--nominal-fg)' },
        caution: { DEFAULT: 'var(--caution)', fg: 'var(--caution-fg)' },
        danger: { DEFAULT: 'var(--danger)', fg: 'var(--danger-fg)' },
        critical: 'var(--critical)',
        app: 'var(--bg-app)',
        sunken: 'var(--bg-sunken)',
        surface: {
          panel: 'var(--surface-panel)', raised: 'var(--surface-raised)',
          input: 'var(--surface-input)', hover: 'var(--surface-hover)',
          overlay: 'var(--surface-overlay)',
        },
        text: {
          primary: 'var(--text-primary)', secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)', disabled: 'var(--text-disabled)',
        },
      },
      borderColor: {
        subtle: 'var(--border-subtle)', DEFAULT: 'var(--border-default)',
        strong: 'var(--border-strong)', input: 'var(--border-input)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
      fontSize: {
        '2xs': 'var(--text-2xs)', xs: 'var(--text-xs)', sm: 'var(--text-sm)',
        base: 'var(--text-base)', md: 'var(--text-md)', lg: 'var(--text-lg)',
        xl: 'var(--text-xl)', '2xl': 'var(--text-2xl)', '3xl': 'var(--text-3xl)',
      },
      borderRadius: {
        xs: 'var(--radius-xs)', sm: 'var(--radius-sm)', md: 'var(--radius-md)',
        lg: 'var(--radius-lg)', xl: 'var(--radius-xl)', pill: 'var(--radius-pill)',
      },
      boxShadow: {
        raised: 'var(--shadow-raised)',
        popover: 'var(--shadow-popover)',
        modal: 'var(--shadow-modal)',
      },
    },
  },
  plugins: [],
} satisfies Config;
