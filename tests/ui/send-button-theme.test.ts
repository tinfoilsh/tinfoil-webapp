import { expect, test } from '@playwright/test'
import {
  SETTINGS_HAS_SEEN_ONBOARDING,
  SETTINGS_THEME,
  SETTINGS_THEME_MODE,
} from '../../src/constants/storage-keys'

const EXPECTED_COLORS = {
  blue: 'rgb(16, 52, 125)',
  blueHover: 'rgb(31, 69, 143)',
  white: 'rgb(255, 255, 255)',
  blueFocusRing: 'rgb(16 52 125 / 1)',
  whiteFocusRing: 'rgb(255 255 255 / 1)',
}

for (const theme of ['light', 'dark']) {
  test(`composer controls use theme blue and visible focus in ${theme} mode`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 800 })
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

    const send = page.getByRole('button', { name: 'Send', exact: true })
    await expect(send).toBeDisabled()
    await expect(send).toHaveCSS('opacity', '0.5')
    await page.locator('#chat-input').fill('Check the button color')
    await expect(send).toBeEnabled()
    await expect(send).toHaveCSS('background-color', EXPECTED_COLORS.blue)
    await expect(send.locator('svg')).toHaveCSS('color', EXPECTED_COLORS.white)
    await send.hover()
    await expect(send).toHaveCSS('background-color', EXPECTED_COLORS.blueHover)
    await page.mouse.move(0, 0)
    await expect(send).toHaveCSS('background-color', EXPECTED_COLORS.blue)
    const modelTrigger = page
      .getByRole('button', { name: /^Current model / })
      .filter({ visible: true })
    await modelTrigger.click()
    const auto = page.getByRole('menuitemradio', { name: /^Auto\b/ })
    await expect(auto).toBeVisible()
    if (
      theme === 'light' &&
      (await auto.getAttribute('aria-checked')) === 'true'
    ) {
      await page
        .getByRole('menuitemradio')
        .filter({ hasNotText: /^Auto\b/ })
        .first()
        .click()
      await expect(auto).toBeHidden()
      await modelTrigger.click()
    }
    if ((await auto.getAttribute('aria-checked')) !== 'true') {
      await auto.click()
      await expect(modelTrigger).toBeFocused()
    }
    const intelligence = page.getByRole('slider', {
      name: 'Auto intelligence',
      exact: true,
    })
    await intelligence.focus()
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(() =>
        intelligence.evaluate((el) =>
          getComputedStyle(el).getPropertyValue('--tw-ring-color'),
        ),
      )
      .toBe(
        theme === 'dark'
          ? EXPECTED_COLORS.whiteFocusRing
          : EXPECTED_COLORS.blueFocusRing,
      )
  })
}
