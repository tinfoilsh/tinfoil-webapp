// A setting that is on or off.
export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  'aria-label': ariaLabel,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  'aria-label'?: string
}) {
  return (
    <label className="relative inline-flex cursor-pointer items-center has-[:disabled]:cursor-default">
      <input
        type="checkbox"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <div className="peer h-5 w-9 rounded-full border border-border-subtle bg-content-muted/40 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-content-muted/70 after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-brand-accent-dark peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-border-strong peer-disabled:opacity-50 dark:peer-checked:bg-brand-accent-light" />
    </label>
  )
}
