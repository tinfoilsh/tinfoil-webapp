import { expect, test } from '@playwright/test'
import { SETTINGS_HAS_SEEN_ONBOARDING } from '../../src/constants/storage-keys'

const PREVIEW_FONT_VARIABLES = [
  '--font-lora',
  '--font-aeonik-fono',
  '--font-opendyslexic',
]

test('loads chat preview fonts before opening settings', async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, 'true')
  }, SETTINGS_HAS_SEEN_ONBOARDING)

  const fontRequests: string[] = []
  page.on('request', (request) => {
    if (
      request.resourceType() === 'font' &&
      request.frame() === page.mainFrame()
    ) {
      fontRequests.push(request.url())
    }
  })
  await page.goto('/')
  await expect(page.locator('#chat-input')).toBeVisible()

  const previewFontUrls = await page.evaluate((variables) => {
    const unquote = (value: string) => value.replace(/['"]/g, '').trim()
    const rootStyle = getComputedStyle(document.documentElement)
    const families = variables.map((variable) =>
      unquote(rootStyle.getPropertyValue(variable).split(',')[0]),
    )
    return Array.from(document.styleSheets).flatMap((sheet) =>
      Array.from(sheet.cssRules).flatMap((rule) => {
        if (!(rule instanceof CSSFontFaceRule)) return []
        const style = rule.style
        if (
          !families.includes(unquote(style.fontFamily)) ||
          style.fontStyle !== 'normal' ||
          !['', 'normal', '400'].includes(style.fontWeight)
        ) {
          return []
        }
        const source = style
          .getPropertyValue('src')
          .match(/url\(["']?([^"')]+)["']?\)/)?.[1]
        return source
          ? [new URL(source, sheet.href ?? document.baseURI).href]
          : []
      }),
    )
  }, PREVIEW_FONT_VARIABLES)

  expect(previewFontUrls).toHaveLength(PREVIEW_FONT_VARIABLES.length)
  for (const url of previewFontUrls) {
    expect(fontRequests).toContain(url)
  }
  const requestsBeforeSettings = [...fontRequests]

  const expandSidebar = page.getByRole('button', { name: 'Expand sidebar' })
  if (await expandSidebar.isVisible()) await expandSidebar.click()
  await page.locator('[data-account-menu-trigger]').click()
  await page.locator('[data-settings-button]').click()
  const settings = page.getByRole('dialog')
  await settings
    .getByRole('button', { name: 'Chat Settings', exact: true })
    .filter({ visible: true })
    .click()

  const previews = settings
    .locator('.font-lora, .font-aeonik-fono, .font-opendyslexic')
    .filter({ hasText: /^Aa$/ })
  await expect(previews).toHaveCount(PREVIEW_FONT_VARIABLES.length)
  const ready = await previews.evaluateAll((elements) =>
    elements.every((element) => {
      const style = getComputedStyle(element)
      // Next's unused fallback face can stay unloaded even when the primary is ready.
      const primaryFamily = style.fontFamily.split(',')[0]
      return document.fonts.check(
        `${style.fontWeight} ${style.fontSize} ${primaryFamily}`,
        element.textContent ?? '',
      )
    }),
  )
  expect(ready).toBe(true)
  expect(fontRequests).toEqual(requestsBeforeSettings)
})
