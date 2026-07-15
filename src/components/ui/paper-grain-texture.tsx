const NOISE_TILE_SIZE = 200
const NOISE_BASE_FREQUENCY = 0.9
const NOISE_OCTAVES = 4

export function PaperGrainTexture({
  className = '',
  opacity = 0.06,
}: {
  className?: string
  opacity?: number
}) {
  const svgPattern = `<svg xmlns='http://www.w3.org/2000/svg' width='${NOISE_TILE_SIZE}' height='${NOISE_TILE_SIZE}'><filter id='paperGrain'><feTurbulence type='fractalNoise' baseFrequency='${NOISE_BASE_FREQUENCY}' numOctaves='${NOISE_OCTAVES}' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#paperGrain)'/></svg>`
  const encodedSvg = `data:image/svg+xml,${encodeURIComponent(svgPattern)}`

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-0 ${className}`}
      style={{
        backgroundImage: `url("${encodedSvg}")`,
        backgroundRepeat: 'repeat',
        opacity,
      }}
    />
  )
}
