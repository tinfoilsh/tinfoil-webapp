import { expect, test, type Locator, type Page } from '@playwright/test'
import { CONSTANTS } from '../../src/components/chat/constants'
import {
  SETTINGS_HAS_SEEN_ONBOARDING,
  SYNC_SESSION_CHATS,
} from '../../src/constants/storage-keys'

const CHAT_TITLE =
  'Header layout check with a long conversation title that stays clear of controls'
const CHAT = {
  id: 'header-layout-check',
  title: CHAT_TITLE,
  createdAt: '2026-09-17T12:00:00Z',
  isLocalOnly: true,
  messages: [
    {
      role: 'user',
      content: 'Synthetic layout check',
      timestamp: '2026-09-17T12:00:00Z',
    },
    {
      role: 'assistant',
      content: 'Synthetic reply',
      timestamp: '2026-09-17T12:00:01Z',
    },
  ],
}

function sidebarToggle(page: Page, width: number) {
  return page.getByRole('button', {
    name:
      width >= CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT
        ? 'Expand sidebar'
        : 'Open sidebar',
    exact: true,
  })
}

async function openFixtureChat(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 })
  await page.addInitScript(
    ({ onboardingKey, chatsKey, chat }) => {
      localStorage.setItem(onboardingKey, 'true')
      sessionStorage.setItem(chatsKey, JSON.stringify([chat]))
    },
    {
      onboardingKey: SETTINGS_HAS_SEEN_ONBOARDING,
      chatsKey: SYNC_SESSION_CHATS,
      chat: CHAT,
    },
  )
  await page.goto('/')
  await sidebarToggle(page, width).waitFor()
  await page.keyboard.press('Control+k')
  await page.getByRole('option', { name: CHAT_TITLE, exact: true }).click()
  return page.locator('header').filter({
    has: page.getByRole('heading', { name: CHAT_TITLE, exact: true }),
  })
}

async function expectNoticeClearOfControls(header: Locator) {
  const notice = header.locator('[data-chat-header-notice]')
  await expect(notice).toBeVisible()
  await expect
    .poll(async () => {
      const [titleBox, noticeBox, shareBox] = await Promise.all([
        header.getByRole('heading').boundingBox(),
        notice.boundingBox(),
        header
          .getByRole('button', { name: 'Share', exact: true })
          .boundingBox(),
      ])
      return (
        titleBox &&
        noticeBox &&
        shareBox &&
        titleBox.x + titleBox.width <= noticeBox.x + 1 &&
        noticeBox.x + noticeBox.width <= shareBox.x + 1
      )
    })
    .toBe(true)
}

for (const width of [1000, 1200]) {
  test(`chat controls adapt to sidebar-constrained content at ${width}px without resizing the window`, async ({
    page,
  }) => {
    await page.route('**/api/keys/chat', (route) =>
      route.fulfill({
        json: {
          key: 'layout-test-token',
          is_free_tier: true,
          rate_limit: {
            remaining: 2,
            limit: 3,
            resets_at: '2099-01-01T00:00:00Z',
          },
        },
      }),
    )
    const header = await openFixtureChat(page, width)
    const shareLabel = header
      .getByRole('button', { name: 'Share', exact: true })
      .getByText('Share', { exact: true })
    const quotaText = 'You have 2 free requests left today'
    const composerQuota = page
      .locator('[data-chat-input-area]')
      .getByText(quotaText, { exact: true })
    const visibleQuota = page
      .getByText(quotaText, { exact: true })
      .filter({ visible: true })
    await expect(shareLabel).toBeVisible()
    await expect(visibleQuota).toHaveCount(1)
    await expect(composerQuota).toBeHidden()
    await expectNoticeClearOfControls(header)

    await sidebarToggle(page, width).click()
    if (width >= CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT) {
      await expect(shareLabel).toBeVisible()
      await header
        .getByRole('button', { name: 'Open verification panel', exact: true })
        .click()
    }

    await expect
      .poll(async () => (await header.boundingBox())!.width)
      .toBeLessThan(CONSTANTS.MOBILE_BREAKPOINT)
    await expect(shareLabel).toBeHidden()
    await expect(
      header.getByRole('link', { name: 'New chat', exact: true }),
    ).toBeVisible()
    await expect
      .poll(
        async () =>
          (await header.locator('#verification-status').boundingBox())!.width,
      )
      .toBeLessThan(CONSTANTS.CHAT_SIDEBAR_COLLAPSED_WIDTH_PX)
    await expect(composerQuota).toBeVisible()
    await expect(visibleQuota).toHaveCount(1)
    await expect
      .poll(async () => {
        const [headerBox, quotaBox] = await Promise.all([
          header.boundingBox(),
          composerQuota.boundingBox(),
        ])
        return (
          headerBox && quotaBox && quotaBox.y >= headerBox.y + headerBox.height
        )
      })
      .toBe(true)
    expect(page.viewportSize()?.width).toBe(width)

    if (width >= CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT) {
      await header
        .getByRole('button', { name: 'Close verification panel', exact: true })
        .click()
    } else {
      await page
        .getByRole('button', { name: 'Close sidebar', exact: true })
        .click()
    }
    await expect(shareLabel).toBeVisible()
    await expect(composerQuota).toBeHidden()
    await expect(visibleQuota).toHaveCount(1)
    await expect(
      header.getByRole('link', { name: 'New chat', exact: true }),
    ).toBeHidden()
    await expectNoticeClearOfControls(header)
  })
}

for (const width of [375, 900, 1200]) {
  test(`chat header and sidebar toggle use the correct layout at ${width}px`, async ({
    page,
  }) => {
    const header = await openFixtureChat(page, width)
    const isDesktop = width >= CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT
    const expectedLeft = isDesktop
      ? CONSTANTS.CHAT_SIDEBAR_COLLAPSED_WIDTH_PX
      : 0
    const openSidebar = sidebarToggle(page, width)
    await expect(openSidebar).toBeVisible()
    await expect(
      header.getByRole('button', { name: 'Open sidebar', exact: true }),
    ).toHaveCount(isDesktop ? 0 : 1)
    await expect(header).toHaveCSS('border-bottom-width', '1px')
    await expect
      .poll(async () => {
        const box = await header.boundingBox()
        return (
          box && {
            left: Math.round(box.x),
            right: Math.round(box.x + box.width),
          }
        )
      })
      .toEqual({ left: expectedLeft, right: width })

    // Hit-test the divider across its actual bounds, including the narrow
    // layout's leading toggle. A sibling must not cover either end.
    await expect
      .poll(() =>
        header.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return [rect.left + 1, rect.left + 24, rect.right - 1].every(
            (x) =>
              document
                .elementFromPoint(x, rect.bottom - 1)
                ?.closest('header') === element,
          )
        }),
      )
      .toBe(true)

    if (isDesktop) {
      const rail = page
        .getByRole('navigation', {
          name: 'Chat history',
          exact: true,
        })
        .and(page.locator('nav:not([inert])'))
      await expect.poll(async () => (await rail.boundingBox())?.y).toBe(0)
      await expect(
        rail.getByRole('button', { name: 'Expand sidebar', exact: true }),
      ).toBeVisible()
    }

    await expect
      .poll(async () =>
        Math.round(
          (await page.locator('[data-scroll-container="main"]').boundingBox())!
            .x,
        ),
      )
      .toBe(isDesktop ? CONSTANTS.CHAT_SIDEBAR_COLLAPSED_WIDTH_PX : 0)

    await openSidebar.click()
    await page
      .getByRole('button', { name: 'Close sidebar', exact: true })
      .click()
    await expect(openSidebar).toBeVisible()
    await expect
      .poll(async () => Math.round((await header.boundingBox())!.x))
      .toBe(expectedLeft)

    if (isDesktop) {
      for (const resizedWidth of [900, width]) {
        const showsRail = resizedWidth >= CONSTANTS.SINGLE_SIDEBAR_BREAKPOINT
        await page.setViewportSize({ width: resizedWidth, height: 800 })
        await expect
          .poll(async () => Math.round((await header.boundingBox())!.x))
          .toBe(showsRail ? CONSTANTS.CHAT_SIDEBAR_COLLAPSED_WIDTH_PX : 0)
        await expect(
          header.getByRole('button', { name: 'Open sidebar', exact: true }),
        ).toHaveCount(showsRail ? 0 : 1)
        await expect(
          page.getByRole('button', { name: 'Expand sidebar', exact: true }),
        ).toHaveCount(showsRail ? 1 : 0)
      }
    }
  })
}
