import { expect, test } from '@playwright/test'
import {
  SETTINGS_HAS_SEEN_ONBOARDING,
  SETTINGS_THEME,
  SETTINGS_THEME_MODE,
} from '../../src/constants/storage-keys'

const ERROR_COMMAND = 'test error'
const VIEWPORT_HEIGHT = 800
const LAYOUT_TOLERANCE = 1

for (const theme of ['light', 'dark']) {
  for (const width of [375, 1200]) {
    test(`simulated error controls fit at ${width}px in ${theme} mode`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT })
      await page.addInitScript(
        ({ theme, onboardingKey, themeKey, modeKey }) => {
          localStorage.setItem(onboardingKey, 'true')
          localStorage.setItem(themeKey, theme)
          localStorage.setItem(modeKey, theme)
        },
        {
          theme,
          onboardingKey: SETTINGS_HAS_SEEN_ONBOARDING,
          themeKey: SETTINGS_THEME,
          modeKey: SETTINGS_THEME_MODE,
        },
      )
      await page.goto('/')
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await page
        .getByRole('button', { name: /^Current model / })
        .filter({ visible: true })
        .click()
      await page.getByRole('menuitemradio', { name: /Dev Simulator/ }).click()
      await page
        .getByRole('textbox', { name: 'Message', exact: true })
        .fill(ERROR_COMMAND)
      await page.getByRole('button', { name: 'Send', exact: true }).click()

      const banner = page
        .getByRole('alert')
        .filter({ hasText: 'Connection problem' })
      const retry = banner.getByRole('button', { name: 'Resend message' })
      const dismiss = banner.getByRole('button', { name: 'Dismiss error' })
      const details = banner.getByRole('button', {
        name: 'Expand error details',
      })
      await expect(banner).toBeVisible()
      await expect(retry).toBeEnabled()
      const radius = await page
        .getByRole('button', { name: 'Send', exact: true })
        .evaluate((element) => getComputedStyle(element).borderTopLeftRadius)
      await expect(retry).toHaveCSS('border-top-left-radius', radius)
      const [bannerBox, retryBox, dismissBox, detailsBox] = await Promise.all([
        banner.boundingBox(),
        retry.boundingBox(),
        dismiss.boundingBox(),
        details.boundingBox(),
      ])
      expect(bannerBox).not.toBeNull()
      expect(retryBox).not.toBeNull()
      expect(dismissBox).not.toBeNull()
      expect(detailsBox).not.toBeNull()
      expect(parseFloat(radius)).toBeLessThan(retryBox!.height / 2)
      expect(dismissBox!.x).toBeCloseTo(detailsBox!.x)
      expect(dismissBox!.y + dismissBox!.height).toBeLessThanOrEqual(
        detailsBox!.y,
      )
      expect(retryBox!.x + retryBox!.width).toBeLessThanOrEqual(dismissBox!.x)
      expect(dismissBox!.y).toBeLessThan(retryBox!.y)
      expect(detailsBox!.y + detailsBox!.height).toBeGreaterThanOrEqual(
        retryBox!.y + retryBox!.height,
      )
      expect(bannerBox!.x).toBeGreaterThanOrEqual(0)
      expect(bannerBox!.x + bannerBox!.width).toBeLessThanOrEqual(
        width + LAYOUT_TOLERANCE,
      )
      await banner.screenshot({ path: test.info().outputPath('banner.png') })

      await details.click()
      await expect(
        banner.getByText(/Simulated connection failure for local testing/),
      ).toBeVisible()
      await expect(
        banner.getByRole('button', { name: 'Collapse error details' }),
      ).toHaveAttribute('aria-expanded', 'true')
      await banner
        .getByRole('button', { name: 'Collapse error details' })
        .click()
      await expect(
        banner.getByText(/Simulated connection failure for local testing/),
      ).toBeHidden()

      await retry.click()
      await expect(banner).toBeVisible()
      await expect(retry).toBeEnabled()
      await dismiss.click()
      await expect(banner).toBeHidden()
      await expect(
        page.getByText(ERROR_COMMAND, { exact: true }).first(),
      ).toBeVisible()
    })
  }
}
