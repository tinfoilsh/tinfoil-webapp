import { useProfileSetting } from '@/services/harness/provider'
export function useEnterToNewline() {
  return useProfileSetting('enterToNewlineEnabled', false)[0]
}
