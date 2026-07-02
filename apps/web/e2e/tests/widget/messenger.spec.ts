import { test, expect } from '@playwright/test'
import { setSupportSurfaces } from '../../utils/db-helpers'

/**
 * Characterization net for the widget messenger, pinning CURRENT anonymous
 * visitor behavior: the widget route loads directly (the SDK normally iframes
 * /widget; the route itself needs no params), the Messages tab lists the
 * visitor's conversations, and the first send lazily mints an anonymous
 * session.
 *
 * KNOWN BUG (pinned, not fixed - this is a characterization net): anonymous
 * session persistence across reloads is currently broken. The client persists
 * better-auth's SIGNED bearer token (raw.signature, from the set-auth-token
 * header) to localStorage, but /api/widget/session -> getWidgetSession()
 * compares that value verbatim against the RAW session.token column, so the
 * mount-time restore always 401s and clears the persisted token. The
 * conversation therefore does NOT survive a reload today. When that bug is
 * fixed, the reload assertions below must be flipped to expect the
 * conversation list to show the thread.
 *
 * Deliberately independent of agent activity - no replies are awaited.
 */
test.describe('Widget messenger (anonymous visitor)', { tag: '@smoke' }, () => {
  test.beforeAll(() => {
    setSupportSurfaces(true)
  })

  test('start a conversation and send a message that renders', async ({ page }) => {
    await page.goto('/widget')

    // Fresh browser context = fresh anonymous visitor: the Messages tab shows
    // the empty state.
    await page.getByRole('button', { name: 'Messages', exact: true }).click()
    await expect(page.getByText('No conversations yet')).toBeVisible({ timeout: 10000 })

    // Start a new conversation from the pinned pill.
    await page.getByRole('button', { name: /Ask a question/ }).click()
    const composer = page.locator('.ProseMirror[contenteditable="true"]')
    await expect(composer).toBeVisible({ timeout: 10000 })

    const message = `Widget e2e message ${Date.now()}`
    await composer.click()
    await composer.fill(message)
    // The first send mints the anonymous session, then creates the conversation.
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText(message)).toBeVisible({ timeout: 15000 })

    // The minted anonymous token is persisted to the iframe-origin localStorage.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window.localStorage.getItem(`quackback:anon-token:${window.location.origin}`)
          ),
        { timeout: 10000 }
      )
      .not.toBeNull()

    // Within the same page session, the Messages list shows the conversation
    // (in-memory token; back via the thread's back affordance is covered by
    // navigating the tab bar after the panel state resets on reload below).

    // CURRENT BEHAVIOR (BUG, see header comment): after a reload the persisted
    // token is rejected by /api/widget/session and cleared, so the visitor's
    // conversation does NOT survive - the Messages tab is empty again.
    await page.reload()
    await page.getByRole('button', { name: 'Messages', exact: true }).click()
    await expect(page.getByText('No conversations yet')).toBeVisible({ timeout: 15000 })
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window.localStorage.getItem(`quackback:anon-token:${window.location.origin}`)
          ),
        { timeout: 10000 }
      )
      .toBeNull()
  })
})
