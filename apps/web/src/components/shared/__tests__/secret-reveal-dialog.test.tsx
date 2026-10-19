// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('@/components/shared/copy-button', () => ({
  CopyButton: ({ 'aria-label': label }: { 'aria-label'?: string }) => (
    <button aria-label={label}>copy</button>
  ),
}))

const { SecretRevealDialog } = await import('../secret-reveal-dialog')

afterEach(cleanup)

describe('SecretRevealDialog wording', () => {
  it.each(['API key', 'Signing secret'])(
    'reads naturally whatever the label (%s)',
    (secretLabel) => {
      render(
        <SecretRevealDialog
          open
          onOpenChange={() => {}}
          title="Created"
          description="Saved."
          secretLabel={secretLabel}
          secretValue="qb_secret"
        />
      )
      expect(screen.getByText('Copy this now')).toBeTruthy()
      expect(screen.getByLabelText('Copy to clipboard')).toBeTruthy()
      expect(screen.getByText(secretLabel)).toBeTruthy()
    }
  )
})
