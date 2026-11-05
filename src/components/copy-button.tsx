import { Button } from '@/components/ui/button'
import { TfBoxCheckmark } from '@tinfoilsh/tinfoil-icons'
import { TfCopyAnimated } from '@tinfoilsh/tinfoil-icons/animated'
import { useState } from 'react'
import { CONSTANTS } from './chat/constants'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), CONSTANTS.COPY_TIMEOUT_MS)
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6"
      onClick={handleCopy}
    >
      {copied ? (
        <TfBoxCheckmark className="h-4 w-4" />
      ) : (
        <TfCopyAnimated className="h-4 w-4" />
      )}
    </Button>
  )
}
export default CopyButton
