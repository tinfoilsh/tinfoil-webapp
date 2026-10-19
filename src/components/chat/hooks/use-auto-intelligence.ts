import { useHarness, useProfileSetting } from '@/services/harness/provider'
export function useAutoIntelligence() {
  const { session } = useHarness()
  const [autoIntelligence, setAutoIntelligence] = useProfileSetting(
    'autoIntelligence',
    session?.auto?.default ?? '',
  )
  return { autoIntelligence, setAutoIntelligence }
}
