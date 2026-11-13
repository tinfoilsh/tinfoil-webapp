import {
  ThoughtProcess as SharedThoughtProcess,
  type ThoughtProcessProps,
} from '@tinfoil/chat-ui/ThoughtProcess'
import { memo } from 'react'
import { StepMarkdown } from './StepMarkdown'

export { ThinkingLabel } from '@tinfoil/chat-ui/ThoughtProcess'

export const ThoughtProcess = memo(function ThoughtProcess(
  props: Omit<ThoughtProcessProps, 'Markdown'>,
) {
  return <SharedThoughtProcess {...props} Markdown={StepMarkdown} />
})
