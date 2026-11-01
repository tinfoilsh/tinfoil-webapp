import type { BaseModel } from '@/config/models'
import { useProfileSetting } from '@/services/harness/provider'
export type ReasoningEffort = 'low' | 'medium' | 'high'
export const DEFAULT_EFFORT: ReasoningEffort = 'medium'
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
export const supportsReasoningEffort = (model?: BaseModel | null) =>
  !!model?.chatConfig?.reasoningConfig?.supportsEffort
export const supportsThinkingToggle = (model?: BaseModel | null) =>
  !!model?.chatConfig?.reasoningConfig?.supportsToggle
