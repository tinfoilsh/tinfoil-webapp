'use client'

import { useMemo } from 'react'
import { useProject } from '../project-context'

interface UseProjectSystemPromptOptions {
  baseSystemPrompt: string
  baseRules?: string
}

interface UseProjectSystemPromptReturn {
  effectiveSystemPrompt: string
  effectiveRules: string
  isProjectMode: boolean
}

export function useProjectSystemPrompt({
  baseSystemPrompt,
  baseRules = '',
}: UseProjectSystemPromptOptions): UseProjectSystemPromptReturn {
  const { isProjectMode, getProjectSystemPrompt } = useProject()

  const effectiveSystemPrompt = useMemo(() => {
    if (!isProjectMode) {
      return baseSystemPrompt
    }

    const projectContext = getProjectSystemPrompt()
    if (!projectContext) {
      return baseSystemPrompt
    }

    return `${baseSystemPrompt}\n\n<project_context>\n${projectContext}\n</project_context>`
  }, [isProjectMode, baseSystemPrompt, getProjectSystemPrompt])

  return {
    effectiveSystemPrompt,
    effectiveRules: baseRules,
    isProjectMode,
  }
}
