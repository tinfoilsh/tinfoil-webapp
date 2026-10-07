import {
  indentCodeBlocksInLists,
  preprocessMarkdown,
} from '@/utils/markdown-preprocessing'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'

describe('markdown-preprocessing', () => {
  describe('preprocessMarkdown', () => {
    it.each([
      '__CODE_BLOCK_0__',
      '__INLINE_CODE_0__',
      '__CODE_BLOCK_0__\n```\nreal code\n```',
      '__INLINE_CODE_0__ and `real code`',
      '__MARKDOWN_CODE_0__ and __MARKDOWN_CODE__0__',
      '__MARKDOWN_CODE_0__INLINE_CODE_0__ __MARKDOWN_CODE_1__CODE_BLOCK_0__ and `real code`',
      '____CODE_BLOCK_0__ and `__INLINE_CODE_0__`',
    ])('preserves literal placeholder-like text: %s', (input) => {
      expect(preprocessMarkdown(input)).toBe(input)
    })

    it.each([
      [
        '10: anchor conversion',
        '<a href="https://example.com">Example</a>',
        '[Example](https://example.com)',
      ],
      [
        '15: empty anchor text',
        '<a href="https://example.com"></a>',
        '[https://example.com](https://example.com)',
      ],
      ['22: bold tag', '<b>bold text</b>', '**bold text**'],
      ['26: strong tag', '<strong>bold text</strong>', '**bold text**'],
      [
        '32: multiple HTML tags',
        'Click <a href="https://x.com">here</a> for <b>details</b>',
        'Click [here](https://x.com) for **details**',
      ],
      [
        '42: fenced HTML',
        '```html\n<a href="url">link</a>\n```',
        '```html\n<a href="url">link</a>\n```',
      ],
      [
        '47: inline HTML code',
        'Use `<b>bold</b>` for emphasis',
        'Use `<b>bold</b>` for emphasis',
      ],
      [
        '52: HTML outside fenced code',
        '<b>bold</b>\n```\n<b>not bold</b>\n```\n<b>bold</b>',
        '**bold**\n```\n<b>not bold</b>\n```\n**bold**',
      ],
      [
        '58: tilde fenced HTML',
        '~~~html\n<a href="url">link</a>\n~~~',
        '~~~html\n<a href="url">link</a>\n~~~',
      ],
      [
        '63: HTML outside tilde fence',
        '<b>bold</b>\n~~~\n<b>not bold</b>\n~~~\n<b>bold</b>',
        '**bold**\n~~~\n<b>not bold</b>\n~~~\n**bold**',
      ],
      [
        '69: longer closing fence resumes conversion',
        '```\n<b>code</b>\n`````\n<b>outside</b>',
        '```\n<b>code</b>\n`````\n**outside**',
      ],
      [
        '74: deeply indented false closer',
        '```\n<b>still code</b>\n    ```\n<b>still code</b>\n```\n<b>bold</b>',
        '```\n<b>still code</b>\n    ```\n<b>still code</b>\n```\n**bold**',
      ],
      [
        '84: shorter false closer',
        '`````\n<b>still code</b>\n```\n<b>still code</b>\n`````\n<b>bold</b>',
        '`````\n<b>still code</b>\n```\n<b>still code</b>\n`````\n**bold**',
      ],
      [
        '93: blockquoted fence',
        '> ```html\n> <a href="url">link</a>\n> ```',
        '> ```html\n> <a href="url">link</a>\n> ```',
      ],
      [
        '98: HTML outside blockquoted fence',
        '<b>bold</b>\n> ```\n> <b>not bold</b>\n> ```\n<b>bold</b>',
        '**bold**\n> ```\n> <b>not bold</b>\n> ```\n**bold**',
      ],
      [
        '107: nested blockquotes',
        '> > ```\n> > <b>code</b>\n> > ```',
        '> > ```\n> > <b>code</b>\n> > ```',
      ],
      [
        '112: invalid backtick info',
        '``` foo `bar`\n<b>bold</b>\n```',
        '``` foo `bar`\n**bold**\n```',
      ],
      [
        '119: valid tilde info with backticks',
        '~~~ foo `bar`\n<b>not bold</b>\n~~~',
        '~~~ foo `bar`\n<b>not bold</b>\n~~~',
      ],
      [
        '126: plain text',
        'Just some plain text without any special formatting',
        'Just some plain text without any special formatting',
      ],
      ['131: empty text', '', ''],
      [
        '135: existing Markdown',
        '**bold** and *italic* and [link](url)',
        '**bold** and *italic* and [link](url)',
      ],
    ])('%s', (_name, input, expected) => {
      expect(preprocessMarkdown(input)).toBe(expected)
    })

    it('142: indents list code and converts HTML into a nested code node', () => {
      const result = preprocessMarkdown(
        '1. <b>Step one</b>:\n```bash\necho hello\n```\n2. Step two',
      )
      expect(result).toBe(
        '1. **Step one**:\n   ```bash\n   echo hello\n   ```\n2. Step two',
      )
      const tree = unified().use(remarkParse).parse(result)
      expect(tree.children).toMatchObject([
        {
          type: 'list',
          ordered: true,
          children: [
            {
              type: 'listItem',
              children: [
                { type: 'paragraph' },
                { type: 'code', lang: 'bash', value: 'echo hello' },
              ],
            },
            { type: 'listItem', children: [{ type: 'paragraph' }] },
          ],
        },
      ])
    })
  })

  describe('indentCodeBlocksInLists', () => {
    it.each([
      [
        '155: ordered list',
        '1. Check this:\n```bash\necho hello\n```\n2. Next step',
        '1. Check this:\n   ```bash\n   echo hello\n   ```\n2. Next step',
      ],
      [
        '171: wider marker',
        '1.  Check this:\n```bash\ngrep microcode /proc/cpuinfo | sort | uniq\n```',
        '1.  Check this:\n    ```bash\n    grep microcode /proc/cpuinfo | sort | uniq\n    ```',
      ],
      [
        '186: double-digit marker',
        '10. Step ten:\n```\ncode here\n```',
        '10. Step ten:\n    ```\n    code here\n    ```',
      ],
      [
        '193: correctly indented block',
        '1. Check this:\n   ```bash\n   echo hello\n   ```',
        '1. Check this:\n   ```bash\n   echo hello\n   ```',
      ],
      [
        '205: dash marker',
        '- Step one:\n```python\nprint("hi")\n```',
        '- Step one:\n  ```python\n  print("hi")\n  ```',
      ],
      [
        '216: asterisk marker',
        '* Step one:\n```\ncode\n```',
        '* Step one:\n  ```\n  code\n  ```',
      ],
      [
        '222: plus marker',
        '+ Step one:\n```\ncode\n```',
        '+ Step one:\n  ```\n  code\n  ```',
      ],
      [
        '230: multiple blocks in one item',
        '1. Do this:\n```bash\nfirst command\n```\n   Then run:\n```bash\nsecond command\n```',
        '1. Do this:\n   ```bash\n   first command\n   ```\n   Then run:\n   ```bash\n   second command\n   ```',
      ],
      [
        '251: different list item widths',
        '1. First:\n```bash\ncmd1\n```\n10. Second:\n```bash\ncmd2\n```',
        '1. First:\n   ```bash\n   cmd1\n   ```\n10. Second:\n    ```bash\n    cmd2\n    ```',
      ],
      [
        '270: continuation after closed fence',
        '1. Check:\n```bash\nsome command\n```\n   Or do something else.',
        '1. Check:\n   ```bash\n   some command\n   ```\n   Or do something else.',
      ],
      [
        '291: tilde fence',
        '1. Check:\n~~~bash\necho hi\n~~~',
        '1. Check:\n   ~~~bash\n   echo hi\n   ~~~',
      ],
      [
        '302: tilde does not close backticks',
        '1. Example:\n```\nline with ~~~\n~~~\nstill in block\n```',
        '1. Example:\n   ```\n   line with ~~~\n   ~~~\n   still in block\n   ```',
      ],
      [
        '320: backticks do not close tildes',
        '1. Example:\n~~~\nline with ```\n```\nstill in block\n~~~',
        '1. Example:\n   ~~~\n   line with ```\n   ```\n   still in block\n   ~~~',
      ],
      [
        '338: shorter fence is content',
        '1. Example:\n`````python\ncode\n```\nstill in block\n`````',
        '1. Example:\n   `````python\n   code\n   ```\n   still in block\n   `````',
      ],
      [
        '356: longer fence closes before prose',
        '1. Example:\n```python\ncode\n`````\nOutside',
        '1. Example:\n   ```python\n   code\n   `````\nOutside',
      ],
      [
        '366: invalid backtick info',
        '1. Example:\n``` foo `bar`\nthis is not code\n```',
        '1. Example:\n``` foo `bar`\nthis is not code\n```',
      ],
      [
        '378: tilde info may contain backticks',
        '1. Example:\n~~~ foo `bar`\nthis is code\n~~~',
        '1. Example:\n   ~~~ foo `bar`\n   this is code\n   ~~~',
      ],
      [
        '395: code outside list',
        'Some text:\n```bash\necho hello\n```',
        'Some text:\n```bash\necho hello\n```',
      ],
      [
        '400: standalone code',
        '```python\nprint("hi")\n```',
        '```python\nprint("hi")\n```',
      ],
      [
        '405: list-like top-level code',
        '```markdown\n1. Item\n```bash\necho hello\n```',
        '```markdown\n1. Item\n```bash\necho hello\n```',
      ],
      [
        '418: list-like correctly indented code',
        '1. Example:\n   ```markdown\n   1. list inside code\n   ```bash\n   echo hello\n   ```',
        '1. Example:\n   ```markdown\n   1. list inside code\n   ```bash\n   echo hello\n   ```',
      ],
      [
        '432: indented false closer',
        '1. Example:\n```\n    ```\nstill in block\n```',
        '1. Example:\n   ```\n       ```\n   still in block\n   ```',
      ],
      [
        '449: nested close permits next block repair',
        '  1. Inner item:\n     ```python\n     code here\n     ```\n  2. Next item:\n```python\nnext\n```',
        '  1. Inner item:\n     ```python\n     code here\n     ```\n  2. Next item:\n     ```python\n     next\n     ```',
      ],
      [
        '463: empty block',
        '1. Empty block:\n```\n```',
        '1. Empty block:\n   ```\n   ```',
      ],
      [
        '473: preserve code indentation',
        '1. Python example:\n```python\ndef foo():\n    return 42\n```',
        '1. Python example:\n   ```python\n   def foo():\n       return 42\n   ```',
      ],
      [
        '490: partial indentation',
        '1. Check:\n ```bash\n echo hello\n ```',
        '1. Check:\n   ```bash\n   echo hello\n   ```',
      ],
      [
        '504: exit list without blank-line masking',
        '1. In list:\n```bash\ncmd1\n```\nNot in list anymore.\n```bash\nstandalone code\n```',
        '1. In list:\n   ```bash\n   cmd1\n   ```\nNot in list anymore.\n```bash\nstandalone code\n```',
      ],
      [
        '526: blank before fence',
        '1. Item\n\n```bash\necho hello\n```',
        '1. Item\n\n```bash\necho hello\n```',
      ],
      [
        '531: new item after blank',
        '1. First item\n\n2. Second item:\n```bash\necho hello\n```',
        '1. First item\n\n2. Second item:\n   ```bash\n   echo hello\n   ```',
      ],
      [
        '549: microcode regression',
        '1.  **Check the running version:**\n```bash\ngrep microcode /proc/cpuinfo | sort | uniq\n```\n2.  **Check the version available in the installed package:**\n    You can use `iucode_tool` to list the microcode revisions contained in the package files:\n```bash\nsudo apt install iucode-tool\niucode_tool -l /lib/firmware/intel-ucode/* | grep -E "signature|revision"\n```\n    Or manually inspect the binary for your specific CPU signature (e.g., `06-55-04`).',
        '1.  **Check the running version:**\n    ```bash\n    grep microcode /proc/cpuinfo | sort | uniq\n    ```\n2.  **Check the version available in the installed package:**\n    You can use `iucode_tool` to list the microcode revisions contained in the package files:\n    ```bash\n    sudo apt install iucode-tool\n    iucode_tool -l /lib/firmware/intel-ucode/* | grep -E "signature|revision"\n    ```\n    Or manually inspect the binary for your specific CPU signature (e.g., `06-55-04`).',
      ],
      [
        '583: mixed code and plain items',
        '1. First item with no code.\n2. Second item has code:\n```js\nconsole.log("hi")\n```\n3. Third item is plain text.\n4. Fourth item also has code:\n```python\nprint("hello")\n```',
        '1. First item with no code.\n2. Second item has code:\n   ```js\n   console.log("hi")\n   ```\n3. Third item is plain text.\n4. Fourth item also has code:\n   ```python\n   print("hello")\n   ```',
      ],
    ])('%s', (_name, input, expected) => {
      expect(indentCodeBlocksInLists(input)).toBe(expected)
    })
  })
})
