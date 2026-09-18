import { expect, test } from '@playwright/test'

test('account menu supports keyboard navigation and nested Help dismissal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/')
  await page
    .getByRole('button', { name: 'Expand sidebar', exact: true })
    .click()
  await expect
    .poll(
      async () => (await page.locator('[data-sidebar-panel]').boundingBox())!.x,
    )
    .toBe(0)
  const trigger = page.locator('[data-account-menu-trigger]')
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await expect(
    page.getByRole('menuitem', { name: 'Sign in', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('ArrowUp')
  const help = page.getByRole('menuitem', { name: 'Help', exact: true })
  await expect(help).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(
    page.getByRole('menuitem', { name: 'Terms of Service', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(
    page.getByRole('menuitem', { name: 'Privacy Policy', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(help).toBeFocused()
  await expect(
    page.getByRole('menu', { name: 'Help', exact: true }),
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(help).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger).not.toBeFocused()
})
