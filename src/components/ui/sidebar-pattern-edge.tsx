export const SIDEBAR_PATTERN_EDGE_WIDTH_PX = 4.5
const TILE_HEIGHT_PX = 14
const BORDER_WIDTH_PX = 0.5
const DARK_PATTERN_COLOR = 'rgba(6, 24, 32, 0.25)'
const LIGHT_PATTERN_COLOR = 'rgba(249, 248, 246, 0.28)'

export function SidebarPatternEdge({ isDarkMode }: { isDarkMode: boolean }) {
  const color = isDarkMode ? LIGHT_PATTERN_COLOR : DARK_PATTERN_COLOR
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIDEBAR_PATTERN_EDGE_WIDTH_PX}" height="${TILE_HEIGHT_PX}">
    <path d="M0.75 0 L3.75 7 L0.75 14" fill="none" stroke="${color}" stroke-width="0.75" />
    <path d="M1.125 4.5 L2.34375 7 L1.125 9.5 Z" fill="${color}" />
    <path d="M3.75 -3 L3.75 3 L2.34375 0 Z M3.75 11 L3.75 17 L2.34375 14 Z" fill="${color}" />
  </svg>`

  return (
    <div
      data-sidebar-pattern-edge
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 right-0 z-20"
      style={{
        width: `${SIDEBAR_PATTERN_EDGE_WIDTH_PX}px`,
        backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(tile)}")`,
        backgroundRepeat: 'repeat-y',
        borderLeft: `${BORDER_WIDTH_PX}px solid ${color}`,
        borderRight: `${BORDER_WIDTH_PX}px solid ${color}`,
      }}
    />
  )
}
