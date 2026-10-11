// @vitest-environment happy-dom
/**
 * A modal footer's submit label can be long ("Post update & reopen as
 * Investigating" in the status editor) and must never be clipped on a narrow
 * screen. The layout itself is the browser's job; this pins the contract that
 * makes it possible: the actions wrap onto another line, and the submit
 * button may wrap its label rather than overflow the footer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ModalFooter } from '../modal-footer'

afterEach(cleanup)

describe('ModalFooter', () => {
  it('lets a long submit label wrap instead of overflowing the footer', () => {
    const label = 'Post update & reopen as Investigating'
    render(<ModalFooter onCancel={vi.fn()} submitLabel={label} submitType="button" />)

    const submit = screen.getByRole('button', { name: label })
    // The whole label is in the button, not cut down to fit.
    expect(submit.textContent).toBe(label)
    expect(submit.className).toContain('whitespace-normal')
    expect(submit.className).not.toContain('whitespace-nowrap')
    expect(submit.className).toContain('max-w-full')
    expect(submit.className).not.toMatch(/(^|\s)h-8(\s|$)/)

    const actions = submit.parentElement as HTMLElement
    expect(actions.className).toContain('flex-wrap')
    expect(actions.className).toContain('min-w-0')
    expect((actions.parentElement as HTMLElement).className).toContain('flex-wrap')
  })
})
