export function GridTexture({
  className = '',
  opacity = 0.04,
}: {
  className?: string
  opacity?: number
}) {
  const size = 16
  const strokeColor = `rgba(0,0,0,${opacity})`

  const svgPattern = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <path d="M ${size} 0 L 0 0 0 ${size}" fill="none" stroke="${strokeColor}" stroke-width="1" />
  </svg>`
  const encodedSvg = `data:image/svg+xml,${encodeURIComponent(svgPattern)}`

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-0 dark:invert ${className}`}
      style={{
        backgroundImage: `url("${encodedSvg}")`,
        backgroundRepeat: 'repeat',
        backgroundPosition: 'center',
      }}
    />
  )
}
