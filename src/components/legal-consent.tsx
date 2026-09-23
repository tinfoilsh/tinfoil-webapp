import { PRIVACY_POLICY_URL, TERMS_URL } from '@/constants/external-links'
import { useId } from 'react'

interface LegalConsentProps {
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}

export function LegalConsent({
  checked,
  disabled,
  onChange,
}: LegalConsentProps) {
  const id = useId()

  return (
    <div className="flex items-start gap-3 text-sm leading-relaxed text-content-secondary">
      <input
        id={id}
        name="legalAccepted"
        type="checkbox"
        required
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-brand-accent-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-strong dark:accent-brand-accent-light"
      />
      <label htmlFor={id}>
        I have read and agree to the{' '}
        <a
          href={TERMS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline transition-colors hover:text-content-primary"
        >
          Terms of Service
        </a>{' '}
        and{' '}
        <a
          href={PRIVACY_POLICY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline transition-colors hover:text-content-primary"
        >
          Privacy Policy
        </a>
        .
      </label>
    </div>
  )
}
