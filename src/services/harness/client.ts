import { API_BASE_URL } from '@/config'
import {
  HarnessClient as SharedHarnessClient,
  type Connect,
  type GetToken,
} from '@tinfoil/chat-client/client'

export * from '@tinfoil/chat-client/client'

export class HarnessClient extends SharedHarnessClient {
  constructor(url: string, getToken: GetToken, connect?: Connect) {
    super(url, getToken, connect, API_BASE_URL)
  }
}
