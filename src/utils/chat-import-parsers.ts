import type { Chat, Message } from '@/components/chat/types'

// Types for ChatGPT export format
export type ChatGPTConversation = {
  title: string
  create_time: number
  update_time: number
  mapping: Record<
    string,
    {
      id: string
      message?: {
        author: { role: string }
        content: {
          content_type: string
          parts?: (string | object)[]
          thoughts?: Array<{ content?: string; summary?: string }>
        }
        create_time?: number
        metadata?: {
          finished_duration_sec?: number
        }
      }
      parent?: string
      children?: string[]
    }
  >
}

// Types for Claude conversations export format
export type ClaudeConversation = {
  uuid: string
  name: string
  created_at: string
  updated_at: string
  chat_messages: Array<{
    uuid: string
    text: string
    sender: 'human' | 'assistant'
    created_at: string
    content?: Array<{
      type: string
      thinking?: string
      start_timestamp?: string
      stop_timestamp?: string
    }>
  }>
}

// Types for Claude projects export format
export type ClaudeProject = {
  uuid: string
  name: string
  description?: string
  prompt_template?: string
  created_at: string
  updated_at: string
  docs?: Array<{
    uuid: string
    filename: string
    content: string
    created_at: string
  }>
}

export type ParseOptions = {
  generateChatId: (createdAt?: Date) => string
  isCloudSyncEnabled: boolean
}

export function parseChatGPTConversations(
  data: ChatGPTConversation[],
  options: ParseOptions,
): Chat[] {
  const chats: Chat[] = []

  for (const conversation of data) {
    const messages: Message[] = []
    const nodeMap = conversation.mapping
    const nodeIds = Object.keys(nodeMap)

    // Helper to look up parent chain for thoughts/reasoning
    const findThoughtsInParentChain = (
      nodeId: string,
    ): { thoughts?: string; thinkingDuration?: number } => {
      let currentId: string | undefined = nodeId
      let thoughts: string | undefined
      let thinkingDuration: number | undefined
      const visited = new Set<string>()

      while (currentId && !visited.has(currentId)) {
        visited.add(currentId)
        const node: (typeof nodeMap)[string] | undefined = nodeMap[currentId]
        if (!node) break

        const msg = node.message
        if (msg) {
          const contentType = msg.content.content_type

          if (contentType === 'thoughts' && msg.content.thoughts) {
            const thoughtTexts = msg.content.thoughts
              .map((t) => t.content || t.summary || '')
              .filter(Boolean)
            if (thoughtTexts.length > 0) {
              thoughts = thoughtTexts.join('\n\n')
            }
          } else if (contentType === 'reasoning_recap') {
            if (msg.metadata?.finished_duration_sec) {
              thinkingDuration = msg.metadata.finished_duration_sec
            }
          }
        }

        currentId = node.parent || undefined
      }

      return { thoughts, thinkingDuration }
    }

    // Find messages by traversing parent-child relationships
    const visitedNodes = new Set<string>()
    const processNode = (nodeId: string) => {
      if (visitedNodes.has(nodeId)) return
      visitedNodes.add(nodeId)

      const node: (typeof nodeMap)[string] | undefined = nodeMap[nodeId]
      if (!node) return

      const msg = node.message
      if (
        msg &&
        (msg.author.role === 'user' || msg.author.role === 'assistant') &&
        (msg.content.content_type === 'text' ||
          msg.content.content_type === 'multimodal_text') &&
        msg.content.parts &&
        msg.content.parts.length > 0
      ) {
        const textParts = msg.content.parts.filter(
          (p): p is string => typeof p === 'string',
        )
        const content = textParts.join('\n').trim()
        if (content) {
          const message: Message = {
            role: msg.author.role as 'user' | 'assistant',
            content,
            timestamp: msg.create_time
              ? new Date(msg.create_time * 1000)
              : new Date(conversation.create_time * 1000),
          }

          if (msg.author.role === 'assistant') {
            const { thoughts, thinkingDuration } =
              findThoughtsInParentChain(nodeId)
            if (thoughts) {
              message.thoughts = thoughts
            }
            if (thinkingDuration) {
              message.thinkingDuration = thinkingDuration
            }
          }

          messages.push(message)
        }
      }

      if (node.children) {
        for (const childId of node.children) {
          processNode(childId)
        }
      }
    }

    // Start from root nodes (nodes without parents or with null parent)
    for (const nodeId of nodeIds) {
      const node = nodeMap[nodeId]
      if (!node.parent || node.parent === 'client-created-root') {
        processNode(nodeId)
      }
    }

    if (messages.length > 0) {
      const createdAt = new Date(conversation.create_time * 1000)
      chats.push({
        id: options.generateChatId(createdAt),
        title: conversation.title || 'Imported Chat',
        messages,
        createdAt,
        isLocalOnly: !options.isCloudSyncEnabled,
      })
    }
  }

  return chats
}

export function parseClaudeConversations(
  data: ClaudeConversation[],
  options: ParseOptions,
): Chat[] {
  const chats: Chat[] = []

  for (const conversation of data) {
    const messages: Message[] = []

    for (const msg of conversation.chat_messages || []) {
      if (msg.text && msg.text.trim()) {
        const message: Message = {
          role: msg.sender === 'human' ? 'user' : 'assistant',
          content: msg.text.trim(),
          timestamp: new Date(msg.created_at),
        }

        if (msg.sender === 'assistant' && msg.content) {
          const thinkingBlocks = msg.content.filter(
            (c) => c.type === 'thinking' && c.thinking,
          )

          if (thinkingBlocks.length > 0) {
            message.thoughts = thinkingBlocks
              .map((t) => t.thinking)
              .filter(Boolean)
              .join('\n\n')

            const timestamps = thinkingBlocks
              .flatMap((t) => [t.start_timestamp, t.stop_timestamp])
              .filter(Boolean)
              .map((ts) => new Date(ts!).getTime())
              .sort((a, b) => a - b)

            if (timestamps.length >= 2) {
              const durationMs =
                timestamps[timestamps.length - 1] - timestamps[0]
              message.thinkingDuration = Math.round(durationMs / 1000)
            }
          }
        }

        messages.push(message)
      }
    }

    if (messages.length > 0) {
      const createdAt = new Date(conversation.created_at)
      chats.push({
        id: options.generateChatId(createdAt),
        title: conversation.name || 'Imported Chat',
        messages,
        createdAt,
        isLocalOnly: !options.isCloudSyncEnabled,
      })
    }
  }

  return chats
}

export type ParsedProject = {
  name: string
  description: string
  systemInstructions: string
  docs: Array<{
    filename: string
    content: string
  }>
}

export function parseClaudeProjects(data: ClaudeProject[]): ParsedProject[] {
  const projects: ParsedProject[] = []

  for (const project of data) {
    const docs: ParsedProject['docs'] = []

    if (project.docs && Array.isArray(project.docs)) {
      for (const doc of project.docs) {
        if (doc.content && doc.filename) {
          docs.push({
            filename: doc.filename,
            content: doc.content,
          })
        }
      }
    }

    // Claude exports include an untouched starter project with no name,
    // instructions, or documents; importing it would only add clutter.
    if (!project.name && !project.prompt_template && docs.length === 0) {
      continue
    }

    projects.push({
      name: project.name || 'Imported Project',
      description: project.description || '',
      systemInstructions: project.prompt_template || '',
      docs,
    })
  }

  return projects
}
