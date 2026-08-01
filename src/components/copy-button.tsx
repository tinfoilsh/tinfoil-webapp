import { Button } from '@/components/ui/button'
import { TfCopy } from '@tinfoilsh/tinfoil-icons'
import { Check } from 'lucide-react'
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
      {copied ? <Check className="h-4 w-4" /> : <TfCopy className="h-4 w-4" />}
    </Button>
  )
}
export default CopyButton
