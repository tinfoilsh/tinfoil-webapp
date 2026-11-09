/**
 * Global color definitions for consistent theming across the application
 *
 * Tinfoil Brand Colors:
 * - tinfoil-dark: #05252E Midnight Petrol (primary dark background)
 * - tinfoil-light: #F2F1EC Bone (light background)
 * - tinfoil-accent-dark: #004444 Deep Teal (primary brand color)
 * - tinfoil-accent-light: #A8C7D1 Steel Mist (accent/success color)
 * - tinfoil-twilight: #6B5B95 Twilight (secondary: cards, hovers, charts)
 * - tinfoil-brass: #C9934F Brass (warm accent, used sparingly)
 */

export const colors = {
  // Tinfoil dark - used for dark backgrounds, headers, text
  'tinfoil-dark': {
    DEFAULT: '#05252E',
    hover: '#08333F',
  },

  // Tinfoil light - used for light backgrounds, cards
  'tinfoil-light': {
    DEFAULT: '#F2F1EC',
    hover: '#EEECE3',
  },

  // Tinfoil accent dark - used for buttons, links, primary actions
  'tinfoil-accent-dark': {
    DEFAULT: '#004444',
    hover: '#005555',
    darker: '#003333',
  },

  // Tinfoil accent light - used for success states, checkmarks, accents
  'tinfoil-accent-light': {
    DEFAULT: '#A8C7D1',
    hover: '#BED7DF',
    darker: '#97B6C0',
  },

  // Tinfoil twilight - secondary color for cards, hovers, charts
  'tinfoil-twilight': {
    DEFAULT: '#6B5B95',
  },

  // Tinfoil brass - warm accent, used sparingly
  'tinfoil-brass': {
    DEFAULT: '#C9934F',
  },

  // Legacy gray colors for general use
  gray: {
    light: '#F2F1EC',
    DEFAULT: '#D1D5DB',
    hover: '#9CA3AF',
  },

  // Alias for legacy references in diagrams/components
  mint: {
    dark: '#004444',
  },
} as const

export const TINFOIL_DARK = colors['tinfoil-dark'].DEFAULT
export const TINFOIL_DARK_HOVER = colors['tinfoil-dark'].hover
export const TINFOIL_LIGHT = colors['tinfoil-light'].DEFAULT
export const TINFOIL_LIGHT_HOVER = colors['tinfoil-light'].hover
export const TINFOIL_ACCENT_DARK = colors['tinfoil-accent-dark'].DEFAULT
export const TINFOIL_ACCENT_DARK_HOVER = colors['tinfoil-accent-dark'].hover
export const TINFOIL_ACCENT_DARK_DARKER = colors['tinfoil-accent-dark'].darker
export const TINFOIL_ACCENT_LIGHT = colors['tinfoil-accent-light'].DEFAULT
export const TINFOIL_ACCENT_LIGHT_HOVER = colors['tinfoil-accent-light'].hover
export const TINFOIL_ACCENT_LIGHT_DARKER = colors['tinfoil-accent-light'].darker

// Tailwind class names for when inline styles aren't suitable
export const colorClasses = {
  'tinfoil-dark': {
    bg: 'bg-brand-dark',
    bgHover: 'hover:bg-brand-dark/90',
    text: 'text-brand-dark',
    textHover: 'hover:text-brand-dark/90',
    border: 'border-brand-dark',
    borderHover: 'hover:border-brand-dark/90',
  },
  'tinfoil-light': {
    bg: 'bg-brand-light',
    bgHover: 'hover:bg-brand-light/90',
    text: 'text-brand-light',
    textHover: 'hover:text-brand-light/90',
    border: 'border-brand-light',
    borderHover: 'hover:border-brand-light/90',
  },
  'tinfoil-accent-dark': {
    bg: 'bg-brand-accent-dark',
    bgHover: 'hover:bg-brand-accent-dark/90',
    bgDarker: 'bg-brand-accent-dark-darker',
    text: 'text-brand-accent-dark',
    textHover: 'hover:text-brand-accent-dark/90',
    border: 'border-brand-accent-dark',
    borderHover: 'hover:border-brand-accent-dark/90',
    ring: 'ring-brand-accent-dark',
  },
  'tinfoil-accent-light': {
    bg: 'bg-brand-accent-light',
    bgHover: 'hover:bg-brand-accent-light/90',
    bgDarker: 'bg-brand-accent-light-darker',
    text: 'text-brand-accent-light',
    textHover: 'hover:text-brand-accent-light/90',
    border: 'border-brand-accent-light',
    borderHover: 'hover:border-brand-accent-light/90',
    ring: 'ring-brand-accent-light',
  },
  teal: {
    bg: 'bg-brand-accent-dark',
    bgHover: 'hover:bg-brand-accent-dark/90',
    text: 'text-brand-accent-dark',
    textHover: 'hover:text-brand-accent-dark/90',
    border: 'border-brand-accent-dark',
    borderHover: 'hover:border-brand-accent-dark/90',
    ring: 'ring-brand-accent-dark',
  },
} as const

export const TINFOIL_COLORS = {
  brand: {
    dark: colors['tinfoil-dark'].DEFAULT,
    light: colors['tinfoil-light'].DEFAULT,
    accentDark: colors['tinfoil-accent-dark'].DEFAULT,
    accentLight: colors['tinfoil-accent-light'].DEFAULT,
  },
  surface: {
    cardLight: colors['tinfoil-light'].DEFAULT,
    cardDark: '#1C1C1E',
  },
  content: {
    inverseLight: colors['tinfoil-light'].DEFAULT,
    inverseDark: colors['tinfoil-dark'].DEFAULT,
  },
  utility: {
    qrForegroundLight: '#0B0B0C',
    qrForegroundDark: '#F9FAFB',
    qrForeground: '#000000',
    destructive: '#CC0000',
  },
} as const
