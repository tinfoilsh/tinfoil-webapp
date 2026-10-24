// Copies the harness's protocol and recorded runs into harness-protocol/, and
// writes the types the protocol describes.
// Usage: node scripts/sync-harness-protocol.mjs [harness checkout]
import { execFileSync } from 'node:child_process'
import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import openapiTS, { astToString } from 'openapi-typescript'
import prettier from 'prettier'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PROTOCOL_DIR = path.join(root, 'harness-protocol')
export const PROTOCOL_DOCUMENT = path.join(PROTOCOL_DIR, 'openapi.yaml')
export const PROTOCOL_TYPES = path.join(root, 'src/services/harness/openapi.ts')

const HEADER = `// Generated from harness-protocol/openapi.yaml by
// \`npm run sync:harness-protocol\`. Do not edit.
`

export async function protocolTypes(document) {
  const source = HEADER + astToString(await openapiTS(document))
  return prettier.format(source, {
    ...(await prettier.resolveConfig(PROTOCOL_TYPES)),
    filepath: PROTOCOL_TYPES,
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const harness = path.resolve(
    process.argv[2] ?? path.join(root, '../confidential-tinfoil-harness'),
  )
  const git = (...args) =>
    execFileSync('git', ['-C', harness, ...args], { encoding: 'utf8' })
  const revision = git('rev-parse', 'HEAD')
  // The copy is of the commit it names, so the harness's protocol must be
  // as committed.
  if (git('status', '--porcelain', '--untracked-files=all', '--', 'protocol'))
    throw new Error(`${harness}/protocol has changes not committed`)
  const source = path.join(harness, 'protocol')
  // Nothing is replaced until the harness's protocol is read and its types
  // are written.
  const types = await protocolTypes(
    await readFile(path.join(source, 'openapi.yaml'), 'utf8'),
  )
  await rm(PROTOCOL_DIR, { recursive: true, force: true })
  await cp(source, PROTOCOL_DIR, { recursive: true })
  await writeFile(path.join(PROTOCOL_DIR, 'revision'), revision)
  await writeFile(PROTOCOL_TYPES, types)
}
