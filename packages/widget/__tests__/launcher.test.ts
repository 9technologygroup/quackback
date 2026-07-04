// @vitest-environment happy-dom
/**
 * The launcher unread badge (Phase 7 unified unread): driven by the iframe's
 * quackback:unread messages, it shows a count only while the widget is CLOSED
 * (an alert on the close icon, or on an already-read open widget, is noise).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createLauncher } from '../src/core/launcher'

const badgeOf = (el: HTMLButtonElement) => el.lastElementChild as HTMLElement

function make() {
  return createLauncher({ placement: 'right', onClick: () => {} })
}

describe('launcher unread badge', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('is hidden by default', () => {
    expect(badgeOf(make().el).style.display).toBe('none')
  })

  it('shows the count when unread while closed', () => {
    const l = make()
    l.setUnread(3)
    const badge = badgeOf(l.el)
    expect(badge.style.display).toBe('flex')
    expect(badge.textContent).toBe('3')
  })

  it('caps the display at 9+', () => {
    const l = make()
    l.setUnread(42)
    expect(badgeOf(l.el).textContent).toBe('9+')
  })

  it('hides again when unread returns to 0', () => {
    const l = make()
    l.setUnread(5)
    l.setUnread(0)
    expect(badgeOf(l.el).style.display).toBe('none')
  })

  it('hides while the widget is open, and returns on close', () => {
    const l = make()
    l.setUnread(4)
    l.setOpen(true)
    expect(badgeOf(l.el).style.display).toBe('none')
    l.setOpen(false)
    expect(badgeOf(l.el).style.display).toBe('flex')
  })

  it('coerces a negative/fractional count defensively', () => {
    const l = make()
    l.setUnread(-3)
    expect(badgeOf(l.el).style.display).toBe('none')
    l.setUnread(2.9)
    expect(badgeOf(l.el).textContent).toBe('2')
  })
})
