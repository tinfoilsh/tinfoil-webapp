import { expect, test } from '@playwright/test'
import { SETTINGS_HAS_SEEN_ONBOARDING } from '../../src/constants/storage-keys'

const VERIFICATION_CENTER_ORIGIN = 'https://verification-center.tinfoil.sh'

test('preloads the closed verification center and opens it without reloading', async ({
  page,
}) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, 'true')
  }, SETTINGS_HAS_SEEN_ONBOARDING)

  let documentRequests = 0
  await page.route(`${VERIFICATION_CENTER_ORIGIN}/**`, async (route) => {
    documentRequests++
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body>Verification center loaded</body></html>',
    })
  })

  await page.goto('/')
  const iframe = page.locator('iframe[title="Tinfoil Verification Center"]')
  await expect(iframe).toBeAttached()
  await expect(iframe).not.toBeInViewport()
  await expect(iframe.contentFrame().locator('body')).toHaveText(
    'Verification center loaded',
  )
  expect(documentRequests).toBe(1)
  expect(
    await iframe.evaluate((element) => {
      element.focus()
      return document.activeElement === element
    }),
  ).toBe(false)

  await page.locator('#verification-status').click()
  await expect(iframe).toBeInViewport()
  await iframe
    .locator('..')
    .getByRole('button', { name: 'Close verification panel', exact: true })
    .click()
  await expect(iframe).not.toBeInViewport()
  await page.locator('#verification-status').click()
  await expect(iframe).toBeInViewport()
  await expect(iframe.contentFrame().locator('body')).toHaveText(
    'Verification center loaded',
  )
  expect(documentRequests).toBe(1)
})
