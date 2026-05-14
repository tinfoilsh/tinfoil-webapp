/**
 * Dev script to verify that we support legacy chat fields (not timeline)
 * Paste this into the browser console (on localhost:3000) to seed a
 * legacy chat (flat fields, no timeline) into sessionStorage.
 *
 * Usage:
 *   1. Open http://localhost:3000 in your browser
 *   2. Open DevTools → Console
 *   3. Paste this entire script and press Enter
 *   4. Refresh the page
 */

;(() => {
  const STORAGE_KEY = 'tinfoil-sync-session-chats'

  const ts = Date.now()
  const rev = String(9999999999999 - ts).padStart(13, '0')
  const chatId = rev + '_legacy-fixture'
  const now = new Date().toISOString()

  const chat = {
    id: chatId,
    title: 'Legacy Fixture (no timeline)',
    titleState: 'manual',
    createdAt: now,
    isLocalOnly: true,
    isBlankChat: false,
    messages: [
      // 1. Simple user message
      {
        role: 'user',
        content: 'Tell me about cats',
        timestamp: now,
      },
      // 2. Assistant with thinking
      {
        role: 'assistant',
        content:
          'Cats are fascinating creatures that have been domesticated for thousands of years. They are known for their agility, independence, and affectionate nature.',
        timestamp: now,
        thoughts:
          'The user wants to know about cats. Let me provide a comprehensive overview covering their history, behavior, and characteristics.',
        isThinking: false,
        thinkingDuration: 2.1,
      },
      // 3. User follow-up
      {
        role: 'user',
        content: 'Can you search for recent cat news?',
        timestamp: now,
      },
      // 4. Assistant with web search BEFORE thinking + annotations
      {
        role: 'assistant',
        content:
          'Here are some recent stories about cats that I found interesting.',
        timestamp: now,
        thoughts:
          'Let me search for recent news about cats and summarize the findings.',
        isThinking: false,
        thinkingDuration: 1.5,
        webSearch: {
          query: 'recent cat news 2025',
          status: 'completed',
          sources: [
            { title: 'Cat News Daily', url: 'https://example.com/cat-news' },
            { title: 'Feline Times', url: 'https://example.com/feline-times' },
          ],
        },
        webSearchBeforeThinking: true,
        annotations: [
          {
            type: 'url_citation',
            url_citation: {
              title: 'Cat News Daily',
              url: 'https://example.com/cat-news',
            },
          },
        ],
      },
      // 5. User asks for article
      {
        role: 'user',
        content: 'Look up that first article',
        timestamp: now,
      },
      // 6. Assistant with URL fetch + web search AFTER thinking
      {
        role: 'assistant',
        content:
          'The article from Cat News Daily discusses the latest trends in cat care, including new dietary recommendations and enrichment activities.',
        timestamp: now,
        thoughts: 'Let me fetch the article and summarize it.',
        isThinking: false,
        thinkingDuration: 1.0,
        urlFetches: [
          {
            id: 'f1',
            url: 'https://example.com/cat-news',
            status: 'completed',
          },
        ],
        webSearch: {
          query: 'recent cat news 2025',
          status: 'completed',
          sources: [
            { title: 'Cat News Daily', url: 'https://example.com/cat-news' },
          ],
        },
        webSearchBeforeThinking: false,
      },
      // 7. User asks for plain answer
      {
        role: 'user',
        content: 'Just give me a simple answer with no thinking',
        timestamp: now,
      },
      // 8. Assistant with content only (no thinking, no tools)
      {
        role: 'assistant',
        content: 'Cats are great pets!',
        timestamp: now,
      },
    ],
  }

  // Read existing chats, append, write back
  const existing = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]')
  existing.push(chat)
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(existing))

  console.log(`✅ Seeded "${chat.title}" with ${chat.messages.length} messages`)
  console.log(`   Refresh the page — it should appear in your chat list.`)
})()
