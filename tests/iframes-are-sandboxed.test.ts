import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Every iframe the chat renders must carry a sandbox attribute. The sandbox
// origin also sandboxes its own pages by CSP header, but the attribute is
// what keeps model-authored content opaque regardless of where it loads.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sourceFiles(p)
    return /\.(tsx|jsx)$/.test(name) ? [p] : []
  })
}

describe('iframe sandbox source lint (rendered behavior covered by components)', () => {
  it('are all sandboxed', () => {
    const offenders: string[] = []
    let frames = 0
    for (const file of sourceFiles('src')) {
      const src = readFileSync(file, 'utf8')
      const source = ts.createSourceFile(
        file,
        src,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      )
      const expected = file.endsWith('verification-sidebar.tsx')
        ? 'allow-scripts allow-same-origin allow-popups'
        : file.endsWith('MapView.tsx')
          ? 'allow-scripts allow-same-origin'
          : 'allow-scripts'
      const visit = (node: ts.Node) => {
        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          node.tagName.getText(source) === 'iframe'
        ) {
          frames++
          const sandbox = node.attributes.properties.find(
            (attribute) =>
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText(source) === 'sandbox',
          )
          if (
            !sandbox ||
            !ts.isJsxAttribute(sandbox) ||
            !sandbox.initializer ||
            !ts.isStringLiteral(sandbox.initializer) ||
            sandbox.initializer.text !== expected
          ) {
            offenders.push(
              `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
            )
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(frames).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })
})
