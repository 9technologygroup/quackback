// @vitest-environment happy-dom
/**
 * The step palette (support platform §4.6 fullscreen builder, React Flow
 * rebuild): search filters the Logic/Actions groups by label, and every item
 * still inserts the right step kind/action type at the active point.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StepPalette } from '../palette'

afterEach(cleanup)

describe('StepPalette', () => {
  it('lists both groups with no query', () => {
    render(<StepPalette onInsert={vi.fn()} />)
    expect(screen.getByText('Logic')).toBeInTheDocument()
    expect(screen.getByText('Actions')).toBeInTheDocument()
    expect(screen.getByText('Condition')).toBeInTheDocument()
    expect(screen.getByText('Apply SLA policy')).toBeInTheDocument()
  })

  it('filters items by label, case-insensitively, and hides empty groups', () => {
    render(<StepPalette onInsert={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Search steps…'), { target: { value: 'tag' } })

    expect(screen.getByText('Add tag')).toBeInTheDocument()
    expect(screen.getByText('Remove tag')).toBeInTheDocument()
    expect(screen.queryByText('Condition')).not.toBeInTheDocument()
    expect(screen.queryByText('Logic')).not.toBeInTheDocument()
    expect(screen.getByText('Actions')).toBeInTheDocument()
  })

  it('shows a no-match message when nothing filters in', () => {
    render(<StepPalette onInsert={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Search steps…'), {
      target: { value: 'zzz-nope' },
    })
    expect(screen.getByText(/No steps match/)).toBeInTheDocument()
  })

  it('inserts a condition, a branch, and a typed action', () => {
    const onInsert = vi.fn()
    render(<StepPalette onInsert={onInsert} />)

    fireEvent.click(screen.getByText('Condition'))
    expect(onInsert).toHaveBeenLastCalledWith('condition')

    fireEvent.click(screen.getByText('Branch into paths'))
    expect(onInsert).toHaveBeenLastCalledWith('branch')

    fireEvent.click(screen.getByText('Set priority'))
    expect(onInsert).toHaveBeenLastCalledWith('action', 'set_priority')
  })
})
