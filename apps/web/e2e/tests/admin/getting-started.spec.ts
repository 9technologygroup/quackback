import { test, expect } from '@playwright/test'

// Admin project uses stored auth state (e2e/.auth/admin.json) — no manual login needed.

test.describe('Launch checklist (Getting Started)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin/getting-started')
    await page.waitForLoadState('networkidle')
  })

  test('page loads and shows launch checklist content', async ({ page }) => {
    await expect(page).toHaveURL(/\/admin\/getting-started/, { timeout: 10000 })
    await expect(page.getByRole('heading', { name: 'Launch checklist' })).toBeVisible()
  })

  test('shows outcome-aware headline', async ({ page }) => {
    const description = page
      .getByText(
        /get your first customer response|get your first conversation|publish your first article|collect your first internal idea|ready for day-to-day work/i
      )
      .first()
    await expect(description).toBeVisible({ timeout: 10000 })
  })

  test('shows core launch tasks', async ({ page }) => {
    // The default tab follows the workspace's stored goal, so pin the
    // product_feedback tab before asserting its tasks (board + widget +
    // invite + logo).
    await page.getByRole('tab', { name: /product feedback/i }).click()
    await expect(page.getByText('Create a feedback board')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Add Quackback to your site')).toBeVisible()
    await expect(page.getByText('Invite a teammate')).toBeVisible()
    await expect(page.getByText('Add your logo')).toBeVisible()
  })

  test('shows segmented progress indicator with step count', async ({ page }) => {
    const progressText = page.getByText(/\d+ of \d+/)
    await expect(progressText).toBeVisible({ timeout: 10000 })
  })

  test('each task has an action link', async ({ page }) => {
    const taskButtons = page.locator('div.divide-y > div a[href]')
    const count = await taskButtons.count()
    expect(count).toBeGreaterThanOrEqual(3)
  })

  test('"Create board" or "View boards" navigates to boards settings', async ({ page }) => {
    const btn = page.getByRole('link', { name: /create board|view boards/i }).first()
    await expect(btn).toBeVisible({ timeout: 10000 })
    await btn.click()
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/admin\/settings\/boards/)
  })

  test('"Add to site" or "Manage widget" navigates to widget settings', async ({ page }) => {
    // Widget task only appears on outcomes that include it — pin the tab.
    await page.getByRole('tab', { name: /product feedback/i }).click()
    const btn = page.getByRole('link', { name: /add to site|manage widget/i }).first()
    await expect(btn).toBeVisible({ timeout: 10000 })
    await btn.click()
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/admin\/settings\/widget/)
  })

  test('page is accessible from the admin sidebar via Launch checklist link', async ({ page }) => {
    await page.goto('/admin/feedback')
    await page.waitForLoadState('networkidle')

    const link = page.getByRole('link', { name: /launch checklist/i }).first()
    // Hidden when all tasks complete — soft skip in that case
    if ((await link.count()) === 0) {
      test.skip()
      return
    }
    await expect(link).toBeVisible({ timeout: 10000 })
    await link.click()
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/admin\/getting-started/)
  })

  test('shows completion message when all tasks are done', async ({ page }) => {
    const progressText = await page.getByText(/\d+ of \d+/).textContent()
    const match = progressText?.match(/^(\d+) of (\d+)$/)
    const isAllDone = match && match[1] === match[2]

    if (isAllDone) {
      await expect(page.getByText(/you're ready/i)).toBeVisible({ timeout: 5000 })
    } else {
      await expect(page.getByText(/you're ready/i)).not.toBeVisible()
    }
  })

  test('page renders without error boundary', async ({ page }) => {
    await expect(page.getByText(/something went wrong|failed to load/i)).not.toBeVisible()
  })
})
