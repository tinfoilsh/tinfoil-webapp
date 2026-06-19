// ---------------------------------------------------------------------------
// Project color palette. A project can be associated with one of these colors,
// which tints its labels and the sidebar background while in project mode.
// ---------------------------------------------------------------------------

export interface ProjectColor {
  id: string
  label: string
  hex: string
  rgb: [number, number, number]
}

export const PROJECT_COLORS: ProjectColor[] = [
  { id: 'maya-blue', label: 'Maya Blue', hex: '#85C6FF', rgb: [133, 198, 255] },
  {
    id: 'electric-aqua',
    label: 'Electric Aqua',
    hex: '#62DCE9',
    rgb: [98, 220, 233],
  },
  {
    id: 'sandy-brown',
    label: 'Sandy Brown',
    hex: '#FFB57A',
    rgb: [255, 181, 122],
  },
  { id: 'mauve', label: 'Mauve', hex: '#E9ABFF', rgb: [233, 171, 255] },
  {
    id: 'tuscan-sun',
    label: 'Tuscan Sun',
    hex: '#F5CB58',
    rgb: [245, 203, 88],
  },
  {
    id: 'light-green',
    label: 'Light Green',
    hex: '#8ADF8D',
    rgb: [138, 223, 141],
  },
  { id: 'baby-pink', label: 'Baby Pink', hex: '#FF9EC3', rgb: [255, 158, 195] },
]

const PROJECT_COLOR_MAP: Record<string, ProjectColor> = PROJECT_COLORS.reduce(
  (acc, color) => {
    acc[color.id] = color
    return acc
  },
  {} as Record<string, ProjectColor>,
)

// Opacity applied when tinting the sidebar background with a project color.
export const PROJECT_COLOR_SIDEBAR_TINT_OPACITY = 0.1

// Opacity applied to the background of project labels (banner and input tab).
export const PROJECT_COLOR_LABEL_TINT_OPACITY = 0.18

export function getProjectColor(id?: string | null): ProjectColor | undefined {
  if (!id) return undefined
  return PROJECT_COLOR_MAP[id]
}

export function projectColorRgba(color: ProjectColor, opacity: number): string {
  const [r, g, b] = color.rgb
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

// A flat translucent layer drawn over an element's existing background-color
// via background-image, so the underlying surface color still shows through.
export function projectColorTintLayer(
  color: ProjectColor,
  opacity: number,
): string {
  const rgba = projectColorRgba(color, opacity)
  return `linear-gradient(${rgba}, ${rgba})`
}
