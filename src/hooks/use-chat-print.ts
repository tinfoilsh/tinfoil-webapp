import { toast } from '@/hooks/use-toast'
import { useCallback, useEffect, useState } from 'react'

interface UseChatPrintOptions {
  printRef: React.RefObject<HTMLDivElement | null>
  enabled?: boolean
}

interface UseChatPrintReturn {
  isGeneratingPdf: boolean
  triggerPrint: () => Promise<void>
}

export function useChatPrint({
  printRef,
  enabled = true,
}: UseChatPrintOptions): UseChatPrintReturn {
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false)

  const triggerPrint = useCallback(async () => {
    if (!printRef.current || isGeneratingPdf) return

    setIsGeneratingPdf(true)
    const element = printRef.current
    try {
      element.classList.remove('hidden')

      const html2pdf = (await import('html2pdf.js')).default
      const blob = await html2pdf()
        .set({
          margin: [15, 15, 15, 15],
          filename: 'chat.pdf',
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        })
        .from(element)
        .outputPdf('blob')

      const pdfUrl = URL.createObjectURL(blob)
      const printWindow = window.open(pdfUrl, '_blank')

      if (printWindow) {
        printWindow.onload = () => {
          printWindow.print()
        }
      }

      setTimeout(() => URL.revokeObjectURL(pdfUrl), 60000)
    } catch {
      toast({ title: 'Failed to generate PDF', variant: 'destructive' })
    } finally {
      element.classList.add('hidden')
      setIsGeneratingPdf(false)
    }
  }, [printRef, isGeneratingPdf])

  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault()
        triggerPrint()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, triggerPrint])

  return {
    isGeneratingPdf,
    triggerPrint,
  }
}
