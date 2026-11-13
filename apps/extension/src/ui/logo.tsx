const LOGO_WIDTH = 194
const LOGO_HEIGHT = 50

export function Logo({
  className,
  dark,
}: {
  className?: string
  dark?: boolean
}) {
  return (
    <img
      src={dark ? '/logo-white.svg' : '/logo-green.svg'}
      alt="Tinfoil"
      width={LOGO_WIDTH}
      height={LOGO_HEIGHT}
      className={className}
    />
  )
}
