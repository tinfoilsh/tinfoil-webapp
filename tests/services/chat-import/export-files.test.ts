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

  it('names the offending file when it is not a JSON array', async () => {
    await expect(
      readExportFiles(
        [
          jsonFile('conversations-1.json', [{ uuid: 'a' }]),
          jsonFile('users.json', { uuid: 'not-an-array' }),
        ],
        'Claude conversations',
      ),
    ).rejects.toThrow('users.json is not a Claude conversations export')
  })

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
