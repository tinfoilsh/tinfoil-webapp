// All site radii follow the global --radius token (see src/styles/tailwind.css)
// so the corner size is tuned in one place.
const BASE_RADIUS = 'var(--radius)'

export const radius = {
  sm: BASE_RADIUS,
  md: BASE_RADIUS,
  lg: BASE_RADIUS,
  base: BASE_RADIUS,
  control: BASE_RADIUS,
  tab: BASE_RADIUS,
} as const
