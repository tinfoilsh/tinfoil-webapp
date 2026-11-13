import {
  indexedDBStorage,
  type IndexedDBStorage,
} from '@/services/storage/indexed-db'
import { Dictation as SharedDictation } from '@tinfoil/chat-client/dictation'
import { transcribe } from './transcribe'

export {
  DictationUnsupportedError,
  type DictationSnapshot,
} from '@tinfoil/chat-client/dictation'

// The app's dictation: transcribed by the harness, and kept in the app's
// storage until its text reaches the composer.
export class Dictation extends SharedDictation {
  constructor(storage: IndexedDBStorage = indexedDBStorage) {
    super(transcribe, storage)
  }
}

export const dictation = new Dictation()
