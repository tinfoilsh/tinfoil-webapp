/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      fontFamily: {
        // Use CSS vars from next/font for consistency across apps
        sans: [
          'var(--font-aeonik)',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Arial',
          'Noto Sans',
          'sans-serif',
          'Apple Color Emoji',
          'Segoe UI Emoji',
        ],
        display: ['var(--font-aeonik)', 'sans-serif'],
        'aeonik-fono': ['var(--font-aeonik-fono)', 'sans-serif'],
        aeonik: ['var(--font-aeonik)', 'sans-serif'],
        system: [
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Helvetica Neue',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        opendyslexic: ['var(--font-opendyslexic)', 'sans-serif'],
        lora: ['var(--font-lora)', 'serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      borderRadius: {
        '4xl': '2rem',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      colors: {
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        brand: {
          dark: 'hsl(var(--color-brand-dark) / <alpha-value>)',
          light: 'hsl(var(--color-brand-light) / <alpha-value>)',
          'accent-dark': 'hsl(var(--color-accent-dark) / <alpha-value>)',
          'accent-dark-darker':
            'hsl(var(--color-accent-dark-darker) / <alpha-value>)',
          'accent-light': 'hsl(var(--color-accent-light) / <alpha-value>)',
          'accent-light-darker':
            'hsl(var(--color-accent-light-darker) / <alpha-value>)',
        },
        surface: {
          background: 'hsl(var(--surface-background) / <alpha-value>)',
          chat: 'hsl(var(--surface-chat) / <alpha-value>)',
          'chat-background':
            'hsl(var(--surface-chat-background) / <alpha-value>)',
          sidebar: 'hsl(var(--surface-sidebar) / <alpha-value>)',
          'sidebar-button':
            'hsl(var(--surface-sidebar-button) / <alpha-value>)',
          'sidebar-button-hover':
            'hsl(var(--surface-sidebar-button-hover) / <alpha-value>)',
          settings: 'hsl(var(--surface-settings) / <alpha-value>)',
          input: 'hsl(var(--surface-input) / <alpha-value>)',
          thinking: 'hsl(var(--surface-thinking) / <alpha-value>)',
          'message-user': 'hsl(var(--surface-message-user) / <alpha-value>)',
          'message-assistant':
            'hsl(var(--surface-message-assistant) / <alpha-value>)',
          card: 'hsl(var(--surface-card) / <alpha-value>)',
        },
        content: {
          primary: 'hsl(var(--content-primary) / <alpha-value>)',
          secondary: 'hsl(var(--content-secondary) / <alpha-value>)',
          muted: 'hsl(var(--content-muted) / <alpha-value>)',
          inverse: 'hsl(var(--content-inverse) / <alpha-value>)',
        },
        gray: {
          50: 'hsl(var(--gray-50) / <alpha-value>)',
          100: 'hsl(var(--gray-100) / <alpha-value>)',
          200: 'hsl(var(--gray-200) / <alpha-value>)',
          300: 'hsl(var(--gray-300) / <alpha-value>)',
          400: 'hsl(var(--gray-400) / <alpha-value>)',
          500: 'hsl(var(--gray-500) / <alpha-value>)',
          600: 'hsl(var(--gray-600) / <alpha-value>)',
          700: 'hsl(var(--gray-700) / <alpha-value>)',
          800: 'hsl(var(--gray-800) / <alpha-value>)',
          900: 'hsl(var(--gray-900) / <alpha-value>)',
          950: 'hsl(var(--gray-950) / <alpha-value>)',
        },
        button: {
          'send-background':
            'hsl(var(--button-send-background) / <alpha-value>)',
          'send-foreground':
            'hsl(var(--button-send-foreground) / <alpha-value>)',
        },
        'border-subtle': 'hsl(var(--border-subtle) / <alpha-value>)',
        'border-strong': 'hsl(var(--border-strong) / <alpha-value>)',
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
        },
      },
      keyframes: {
        scroll: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'spring-horizontal': {
          '0%, 100%': { transform: 'translateX(0)' },
          '25%': { transform: 'translateX(3px)' },
          '75%': { transform: 'translateX(-3px)' },
        },
      },
      animation: {
        scroll: 'scroll 12s linear infinite',
        shimmer: 'shimmer 3s ease-in-out infinite',
        fadeIn: 'fadeIn 1s ease-in-out forwards',
        'spring-horizontal': 'spring-horizontal 0.5s ease-in-out infinite',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
    require('@tailwindcss/container-queries'),
    require('tailwindcss-animate'),
  ],
}

// Add custom styles to base layer
const plugin = require('tailwindcss/plugin')
module.exports.plugins.push(
  plugin(function ({ addUtilities }) {
    addUtilities({
      '.no-scrollbar': {
        '-ms-overflow-style': 'none',
        'scrollbar-width': 'none',
        '&::-webkit-scrollbar': {
          display: 'none',
        },
      },
    })
  }),
)
