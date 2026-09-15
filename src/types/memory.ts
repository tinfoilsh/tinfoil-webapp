/**
 * Memory types for the factoid-based memory system
 * Extracts and stores discrete facts/preferences from user messages
 */

export interface Fact {
  id: string // unique identifier
  fact: string
  date: string // ISO timestamp
  category: string // LLM-determined category
  confidence: number // 0-1 confidence score
}
