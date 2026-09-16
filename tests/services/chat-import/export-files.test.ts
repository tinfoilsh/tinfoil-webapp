import { isZipFile, readExportFiles } from '@/services/chat-import/export-files'
import {
  parseClaudeProjects,
  type ClaudeProject,
} from '@/utils/chat-import-parsers'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const jsonFile = (name: string, value: unknown) =>
  new File([JSON.stringify(value)], name, { type: 'application/json' })

const fixtureFile = (name: string) =>
  new File(
    [
      readFileSync(
        join(__dirname, '../../fixtures/claude-projects-split', name),
      ),
    ],
    name,
    { type: 'application/json' },
  )

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

  it('treats a single-object file as one record', async () => {
    const records = await readExportFiles<{ uuid: string }>(
      [
        jsonFile('one.json', { uuid: 'a' }),
        jsonFile('many.json', [{ uuid: 'b' }]),
      ],
      'Claude projects',
    )

    expect(records.map((r) => r.uuid)).toEqual(['a', 'b'])
  })

  it('names the offending file when it holds neither a record nor an array', async () => {
    await expect(
      readExportFiles(
        [
          jsonFile('conversations-1.json', [{ uuid: 'a' }]),
          jsonFile('users.json', 'just a string'),
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

  it('imports a real per-project Claude export folder', async () => {
    const records = await readExportFiles<ClaudeProject>(
      [
        fixtureFile('019740f9-c653-7517-a8a7-df268f0c7062.json'),
        fixtureFile('019ef151-6dd2-76d5-abf7-91e33254dff8.json'),
      ],
      'Claude projects',
    )
    expect(records).toHaveLength(2)

    const projects = parseClaudeProjects(records)
    expect(projects).toHaveLength(1)
    expect(projects[0].name).toBe('Blog Diagrams')
    expect(projects[0].systemInstructions).toMatch(/^In this project/)
    expect(projects[0].docs).toEqual([])
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
