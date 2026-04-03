import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: '#09090b',
        foreground: '#fafafa',
        primary: '#3b82f6',
        brand: '#e5a800',
        secondary: '#27272a',
        muted: '#a1a1aa',
        destructive: '#dc2626',
        success: '#16a34a',
        info: '#0ea5e9',
      },
      fontFamily: {
        sans: ['var(--font-heebo)', 'Heebo', 'sans-serif'],
        heading: ['var(--font-unbounded)', 'Unbounded', 'sans-serif'],
      },
      borderRadius: {
        xl: '0.75rem',
      },
    },
  },
  plugins: [],
};

export default config;
