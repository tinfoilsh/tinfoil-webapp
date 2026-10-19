/**
 * Escape user-controlled text before interpolating it into a delimited
 * system prompt block such as `<user_preferences>` or `<project_context>`.
 *
 * Neutralising `<`, `>`, and `&` means a closing tag inside a nickname,
 * project instruction, or uploaded document cannot terminate the block it
 * is embedded in and be read as top-level instructions. Models read the
 * escaped forms without difficulty.
 */
export function escapePromptContent(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
