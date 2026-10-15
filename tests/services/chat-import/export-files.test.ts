import { isZipFile, readExportFiles } from '@/services/chat-import/export-files'
import { describe, expect, it } from 'vitest'

const jsonFile = (name: string, value: unknown) =>
  new File([JSON.stringify(value)], name, { type: 'application/json' })

describe('readExportFiles', () => {
  it('concatenates records from split export files in selection order', async () => {
    const records = await readExportFiles<{ uuid: string }>(
      [
        jsonFile('conversations-1.json', [{ uuid: 'a' }, { uuid: 'b' }]),
        jsonFile('conversations-2.json', [{ uuid: 'c' }]),
        jsonFile('conversations-3.json', []),
      ],
      'Claude conversations',
    )

    expect(records.map((r) => r.uuid)).toEqual(['a', 'b', 'c'])
  })

  it('rejects stray object files in a conversations export', async () => {
    await expect(
      readExportFiles(
        [
          jsonFile('conversations.json', [{ mapping: {} }]),
          jsonFile('users.json', { id: 'user-1', email: 'a@b.c' }),
        ],
        'ChatGPT conversations',
      ),
    ).rejects.toThrow('users.json is not a ChatGPT conversations export')
  })

  it.each(['just a string', null, 42])(
    'names a file holding %j instead of a list',
    async (value) => {
      await expect(
        readExportFiles(
          [
            jsonFile('conversations-1.json', [{ uuid: 'a' }]),
            jsonFile('users.json', value),
          ],
          'Claude conversations',
        ),
      ).rejects.toThrow('users.json is not a Claude conversations export')
    },
  )

  it('names the offending file when it is not valid JSON', async () => {
    await expect(
      readExportFiles(
        [new File(['{ nope'], 'conversations-2.json')],
        'Claude conversations',
      ),
    ).rejects.toThrow('conversations-2.json is not valid JSON')
  })
})

describe('isZipFile', () => {
  it('detects archives by extension or mime type', () => {
    expect(isZipFile(new File([], 'export.ZIP'))).toBe(true)
    expect(isZipFile(new File([], 'export', { type: 'application/zip' }))).toBe(
      true,
    )
    expect(isZipFile(jsonFile('conversations.json', []))).toBe(false)
  })
})
