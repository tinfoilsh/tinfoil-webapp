import type { Message } from '@/components/chat/types'
import { getAIModels, getMemoryPrompt } from '@/config/models'
import { sendStructuredCompletion } from '@/services/inference/inference-client'
import type {
  ExtractFactsResult,
  Fact,
  FactOperation,
  MemoryState,
} from '@/types/memory'
import {
  FACT_OPERATIONS_SCHEMA,
  MAX_FACTS,
  MIN_WORD_COUNT,
} from '@/types/memory'
import { logError, logInfo } from '@/utils/error-handling'

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function formatFactsWithIds(facts: Fact[]): string {
  if (facts.length === 0) return '(No previous facts)'
  return facts
    .map(
      (f) =>
        `[id: ${f.id}] [${f.category}] ${f.fact} (confidence: ${f.confidence}, date: ${f.date})`,
    )
    .join('\n')
}

function formatConversation(
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    timestamp: string
  }>,
): string {
  return messages
    .map((m) => {
      const role = m.role === 'user' ? 'User' : 'Assistant'
      return `[${m.timestamp}] ${role}: ${m.content}`
    })
    .join('\n\n')
}

function generateFactId(): string {
  return crypto.randomUUID()
}

export async function extractFacts(params: {
  currentMemory: MemoryState
  messages: Message[]
  signal?: AbortSignal
}): Promise<ExtractFactsResult> {
  const { currentMemory, messages, signal } = params

  logInfo('Starting fact extraction', {
    component: 'FactExtractor',
    action: 'extractFacts',
    metadata: {
      totalMessages: messages.length,
      currentFactsCount: currentMemory.facts.length,
      lastProcessedTimestamp: currentMemory.lastProcessedTimestamp,
    },
  })

  const lastProcessed = currentMemory.lastProcessedTimestamp
    ? new Date(currentMemory.lastProcessedTimestamp)
    : null

  // Include both user and assistant messages for full conversation context
  const relevantMessages = messages.filter((msg) => {
    // Skip system messages
    if (msg.role !== 'user' && msg.role !== 'assistant') return false
    // Skip messages already processed
    if (lastProcessed && msg.timestamp <= lastProcessed) return false
    // For user messages, require minimum word count
    if (msg.role === 'user' && countWords(msg.content || '') < MIN_WORD_COUNT) {
      return false
    }
    return true
  })

  // Check if there are any new user messages to process
  const newUserMessages = relevantMessages.filter((m) => m.role === 'user')

  logInfo('Filtered messages for extraction', {
    component: 'FactExtractor',
    action: 'extractFacts',
    metadata: {
      relevantMessagesCount: relevantMessages.length,
      newUserMessagesCount: newUserMessages.length,
      userMessagesTotal: messages.filter((m) => m.role === 'user').length,
    },
  })

  if (newUserMessages.length === 0) {
    return { operations: [], processedCount: 0 }
  }

  const models = (await getAIModels()) ?? []
  // Structured outputs require a model that supports it - use gpt-oss-120b specifically
  const structuredModel =
    models.find((m) => m.modelName === 'gpt-oss-120b') || models[0]
  if (!structuredModel) {
    logError('No model available for fact extraction', new Error('No model'), {
      component: 'FactExtractor',
      action: 'extractFacts',
      metadata: { modelsCount: models.length },
    })
    return { operations: [], processedCount: 0 }
  }

  logInfo('Using model for fact extraction', {
    component: 'FactExtractor',
    action: 'extractFacts',
    metadata: { modelName: structuredModel.modelName },
  })

  const promptTemplate = await getMemoryPrompt()
  if (!promptTemplate) {
    logError(
      'No memory prompt template available',
      new Error('No prompt template'),
      {
        component: 'FactExtractor',
        action: 'extractFacts',
      },
    )
    return { operations: [], processedCount: 0 }
  }

  logInfo('Got memory prompt template', {
    component: 'FactExtractor',
    action: 'extractFacts',
    metadata: { promptLength: promptTemplate.length },
  })

  // Format conversation with both user and assistant messages
  const formattedConversation = relevantMessages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content || '',
    timestamp: m.timestamp.toISOString(),
  }))

  const prompt = promptTemplate
    .replace('{CURRENT_FACTS}', formatFactsWithIds(currentMemory.facts))
    .replace(
      '{CONVERSATION_CONTEXT}',
      formatConversation(formattedConversation),
    )

  try {
    const result = await sendStructuredCompletion<{
      operations: FactOperation[]
    }>({
      model: structuredModel,
      messages: [
        {
          role: 'system',
          content:
            'Analyze conversation and manage user facts. Output valid JSON only.',
        },
        { role: 'user', content: prompt },
      ],
      jsonSchema: FACT_OPERATIONS_SCHEMA,
      signal,
    })

    // Filter out invalid operations (model may return invalid action types)
    const validActions = ['add', 'update', 'delete'] as const
    const validOperations = result.operations.filter((op) =>
      validActions.includes(op.action as (typeof validActions)[number]),
    )

    const addCount = validOperations.filter((o) => o.action === 'add').length
    const updateCount = validOperations.filter(
      (o) => o.action === 'update',
    ).length
    const deleteCount = validOperations.filter(
      (o) => o.action === 'delete',
    ).length

    logInfo('Extracted fact operations from messages', {
      component: 'FactExtractor',
      action: 'extractFacts',
      metadata: {
        relevantMessagesCount: relevantMessages.length,
        operationsCount: validOperations.length,
        addCount,
        updateCount,
        deleteCount,
      },
    })

    return {
      operations: validOperations,
      processedCount: newUserMessages.length,
    }
  } catch (error) {
    logError('Failed to extract facts', error, {
      component: 'FactExtractor',
      action: 'extractFacts',
    })
    return { operations: [], processedCount: 0 }
  }
}

export function applyFactOperations(
  existing: Fact[],
  operations: FactOperation[],
): Fact[] {
  let facts = [...existing]

  for (const op of operations) {
    switch (op.action) {
      case 'add': {
        const newFact: Fact = {
          id: generateFactId(),
          ...op.fact,
        }
        facts.push(newFact)
        break
      }
      case 'update': {
        const index = facts.findIndex((f) => f.id === op.factId)
        if (index !== -1) {
          facts[index] = {
            ...facts[index],
            ...op.updates,
          }
        }
        break
      }
      case 'delete': {
        facts = facts.filter((f) => f.id !== op.factId)
        break
      }
    }
  }

  // Enforce MAX_FACTS limit, keeping newest facts
  if (facts.length > MAX_FACTS) {
    facts.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    )
    return facts.slice(0, MAX_FACTS)
  }

  return facts
}
