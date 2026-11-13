import { useProfileSetting } from '@/services/harness/provider'
import {
  DEFAULT_EFFORT,
  type ReasoningEffort,
} from '@tinfoil/chat-client/models'

export {
  DEFAULT_EFFORT,
  supportsReasoningEffort,
  supportsThinkingToggle,
  type ReasoningEffort,
} from '@tinfoil/chat-client/models'
export function useReasoningEffort() {
  const [reasoningEffort, setReasoningEffort] =
    useProfileSetting<ReasoningEffort>('reasoningEffort', DEFAULT_EFFORT)
  return { reasoningEffort, setReasoningEffort }
}
export function useThinkingEnabled() {
  const [thinkingEnabled, setThinkingEnabled] = useProfileSetting(
    'thinkingEnabled',
    true,
  )
  return { thinkingEnabled, setThinkingEnabled }
}
