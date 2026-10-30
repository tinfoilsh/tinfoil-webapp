// Writes the types of the widget arguments the harness declares and
// validates. Usage: node scripts/generate-widget-types.mjs [widgets.json]
import { compile } from 'json-schema-to-typescript'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import prettier from 'prettier'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const WIDGETS_JSON = path.resolve(
  root,
  '../confidential-tinfoil-harness/widgets.json',
)
export const WIDGET_TYPES = path.join(
  root,
  'src/components/chat/genui/widget-args.ts',
)

const HEADER = `// Generated from the harness's widgets.json by \`npm run generate:widgets\`.
// Do not edit.
`

// render_stat_cards: RenderStatCardsArgs
const typeName = (name) =>
  name
    .split('_')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('') + 'Args'

export async function widgetTypes(declarations) {
  const types = []
  for (const { name, schema } of declarations) {
    types.push(
      await compile(schema, typeName(name), {
        bannerComment: '',
        additionalProperties: false,
        ignoreMinAndMaxItems: true,
        format: false,
      }),
    )
  }
  const byName = declarations
    .map(({ name }) => `  ${name}: ${typeName(name)}`)
    .join('\n')
  const source = `${HEADER}\n${types.join('\n')}
// The arguments of each widget, by its tool name.
export interface WidgetArgs {
${byName}
}
`
  return prettier.format(source, {
    ...(await prettier.resolveConfig(WIDGET_TYPES)),
    filepath: WIDGET_TYPES,
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = path.resolve(process.argv[2] ?? WIDGETS_JSON)
  const declarations = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(WIDGET_TYPES, await widgetTypes(declarations))
}
