import { latestChatsOutsideProjects } from '@/services/harness/search'
import { expect, it } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'
import { storedThread } from './thread-fixture'

it('stops reading pages when the harness repeats a cursor', async () => {
  const api = signIn({ cloud: true })
  const inProject = {
    ...storedThread('project-chat', { projectId: 'project-one' }),
    messageCount: 1,
  }
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/threads/list')
      return { threads: [inProject], nextCursor: 'same' }
    throw new Error(`Unexpected request: ${path}`)
  })

  await expect(latestChatsOutsideProjects(api, 8)).resolves.toEqual([])
  expect(client.post.mock.calls.map(([, input]) => input)).toEqual([
    { key: KEY, limit: 100 },
    { key: KEY, limit: 100, cursor: 'same' },
  ])
})
