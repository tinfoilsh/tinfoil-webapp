import { API_BASE_URL } from '@/config'
import { AnonymousCredentialCache as SharedCache } from '@tinfoil/chat-client/anonymous-credential'

export class AnonymousCredentialCache extends SharedCache {
  constructor() {
    super(API_BASE_URL)
  }
}
