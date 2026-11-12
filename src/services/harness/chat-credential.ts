import { API_BASE_URL } from '@/config'
import { ChatCredentialCache as SharedCache } from '@tinfoil/chat-client/chat-credential'
import type { RateLimit } from '@tinfoil/chat-client/types'

export class ChatCredentialCache extends SharedCache {
  constructor(onRateLimit: (rateLimit: RateLimit) => void) {
    super(onRateLimit, API_BASE_URL)
  }
}
