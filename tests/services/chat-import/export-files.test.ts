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

  it('treats a single-object file as one record when allowed', async () => {
    const records = await readExportFiles<{ uuid: string }>(
      [
        jsonFile('one.json', { uuid: 'a' }),
        jsonFile('many.json', [{ uuid: 'b' }]),
      ],
      'Claude projects',
      { allowSingleRecord: true },
    )

    expect(records.map((r) => r.uuid)).toEqual(['a', 'b'])
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
        fixtureFile('01a0c2d4-with-docs.json'),
      ],
      'Claude projects',
      { allowSingleRecord: true },
    )
    expect(records).toHaveLength(3)

    const projects = parseClaudeProjects(records)
    expect(projects.map((p) => p.name)).toEqual([
      'Blog Diagrams',
      'Release Notes',
    ])
    expect(projects[0].systemInstructions).toMatch(/^In this project/)
    expect(projects[0].docs).toEqual([])
    expect(projects[1].docs).toEqual([
      {
        filename: 'style-guide.md',
        content: '# Style guide\n\nUse plain English.',
      },
    ])
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
