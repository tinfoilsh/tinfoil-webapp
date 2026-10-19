import { useCallback, useMemo, useReducer } from 'react'
import type { Chat } from '../types'

type EntityKey = string

interface ChatCollectionState {
  entities: Map<EntityKey, Chat>
  orderedKeys: EntityKey[]
  currentKey: EntityKey
  nextDetachedKey: number
}

type ChatCollectionAction =
  | { type: 'setChats'; action: React.SetStateAction<Chat[]> }
  | { type: 'setCurrentChat'; action: React.SetStateAction<Chat> }
  | {
      type: 'setCollection'
      action: (previous: InitialChatCollection) => InitialChatCollection
    }

interface InitialChatCollection {
  chats: Chat[]
  currentChat: Chat
}

function chatIdentity(chat: Chat): string {
  if (chat.id !== '') {
    return `chat:${chat.id}`
  }

  return chat.isLocalOnly ? 'empty:local' : 'empty:cloud'
}

function getEntity(entities: Map<EntityKey, Chat>, key: EntityKey): Chat {
  const chat = entities.get(key)
  if (!chat) throw new Error(`Missing chat entity for key "${key}"`)
  return chat
}

function materializeChats(state: ChatCollectionState): Chat[] {
  return state.orderedKeys.map((key) => getEntity(state.entities, key))
}

function findOrderedKey(
  state: ChatCollectionState,
  identity: string,
): EntityKey | undefined {
  return state.orderedKeys.find(
    (key) => chatIdentity(getEntity(state.entities, key)) === identity,
  )
}

function initializeChatCollection({
  chats,
  currentChat,
}: InitialChatCollection): ChatCollectionState {
  const entities = new Map<EntityKey, Chat>()
  const orderedKeys = chats.map((chat, index) => {
    const key = `${chatIdentity(chat)}:${index}`
    entities.set(key, chat)
    return key
  })
  const currentIdentity = chatIdentity(currentChat)
  const currentKey =
    orderedKeys.find(
      (key) => chatIdentity(getEntity(entities, key)) === currentIdentity,
    ) ?? `${currentIdentity}:current:0`

  entities.set(currentKey, currentChat)

  return { entities, orderedKeys, currentKey, nextDetachedKey: 1 }
}

function reduceChatCollection(
  state: ChatCollectionState,
  action: ChatCollectionAction,
): ChatCollectionState {
  if (action.type === 'setCollection') {
    const next = action.action({
      chats: materializeChats(state),
      currentChat: getEntity(state.entities, state.currentKey),
    })
    const currentIdentity = chatIdentity(next.currentChat)

    return initializeChatCollection({
      chats: next.chats.map((chat) =>
        chatIdentity(chat) === currentIdentity ? next.currentChat : chat,
      ),
      currentChat: next.currentChat,
    })
  }

  if (action.type === 'setChats') {
    const previousChats = materializeChats(state)
    const nextChats =
      typeof action.action === 'function'
        ? action.action(previousChats)
        : action.action
    const availableKeysByIdentity = new Map<string, EntityKey[]>()
    for (const key of state.orderedKeys) {
      const identity = chatIdentity(getEntity(state.entities, key))
      const keys = availableKeysByIdentity.get(identity)
      if (keys) keys.push(key)
      else availableKeysByIdentity.set(identity, [key])
    }
    const entities = new Map<EntityKey, Chat>()
    const currentChat = getEntity(state.entities, state.currentKey)
    const currentIdentity = chatIdentity(currentChat)
    let nextDetachedKey = state.nextDetachedKey

    const orderedKeys = nextChats.map((chat) => {
      const identity = chatIdentity(chat)
      const existingKey = availableKeysByIdentity.get(identity)?.shift()
      let key: EntityKey

      if (existingKey) {
        key = existingKey
      } else if (identity === currentIdentity) {
        key = state.currentKey
      } else {
        key = `${identity}:entity:${nextDetachedKey++}`
      }

      entities.set(key, chat)
      return key
    })
    const currentKey =
      orderedKeys.find(
        (key) => chatIdentity(getEntity(entities, key)) === currentIdentity,
      ) ?? state.currentKey

    if (!entities.has(currentKey)) {
      entities.set(currentKey, currentChat)
    }

    return { entities, orderedKeys, currentKey, nextDetachedKey }
  }

  const previousCurrent = getEntity(state.entities, state.currentKey)
  const nextCurrent =
    typeof action.action === 'function'
      ? action.action(previousCurrent)
      : action.action
  const previousIdentity = chatIdentity(previousCurrent)
  const nextIdentity = chatIdentity(nextCurrent)
  const entities = new Map(state.entities)

  if (previousIdentity === nextIdentity) {
    entities.set(state.currentKey, nextCurrent)
    const orderedKey = findOrderedKey(state, nextIdentity)
    if (orderedKey !== undefined) {
      entities.set(orderedKey, nextCurrent)
    }
    return { ...state, entities }
  }

  const orderedKey = findOrderedKey(state, nextIdentity)
  if (orderedKey !== undefined) {
    entities.set(orderedKey, nextCurrent)
    return { ...state, entities, currentKey: orderedKey }
  }

  const detachedKey = `${nextIdentity}:current:${state.nextDetachedKey}`
  entities.set(detachedKey, nextCurrent)

  return {
    ...state,
    entities,
    currentKey: detachedKey,
    nextDetachedKey: state.nextDetachedKey + 1,
  }
}

export function useChatCollection(initializer: () => InitialChatCollection): {
  chats: Chat[]
  currentChat: Chat
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>
  setCurrentChat: React.Dispatch<React.SetStateAction<Chat>>
  setChatCollection: (
    action: (previous: InitialChatCollection) => InitialChatCollection,
  ) => void
} {
  const [state, dispatch] = useReducer(
    reduceChatCollection,
    initializer,
    (createInitialCollection) =>
      initializeChatCollection(createInitialCollection()),
  )
  const setChats = useCallback(
    (action: React.SetStateAction<Chat[]>) =>
      dispatch({ type: 'setChats', action }),
    [],
  )
  const setCurrentChat = useCallback(
    (action: React.SetStateAction<Chat>) =>
      dispatch({ type: 'setCurrentChat', action }),
    [],
  )
  const setChatCollection = useCallback(
    (action: (previous: InitialChatCollection) => InitialChatCollection) =>
      dispatch({ type: 'setCollection', action }),
    [],
  )
  const chats = useMemo(() => materializeChats(state), [state])

  return {
    chats,
    currentChat: getEntity(state.entities, state.currentKey),
    setChats,
    setCurrentChat,
    setChatCollection,
  }
}
