import { describe, it, expect } from 'vitest'
import {
  requireApprovalToToggles,
  togglesToRequireApproval,
  type RequireApprovalLevel,
} from '../moderation-policy'

const LEVELS: RequireApprovalLevel[] = ['none', 'anonymous', 'authenticated', 'all']

describe('moderation-policy mapping', () => {
  it('requireApprovalToToggles maps each approval level to the right toggle pair', () => {
    expect(requireApprovalToToggles('none')).toEqual({ anonymous: false, authenticated: false })
    expect(requireApprovalToToggles('anonymous')).toEqual({ anonymous: true, authenticated: false })
    expect(requireApprovalToToggles('authenticated')).toEqual({
      anonymous: false,
      authenticated: true,
    })
    expect(requireApprovalToToggles('all')).toEqual({ anonymous: true, authenticated: true })
  })

  it('togglesToRequireApproval maps each toggle combination to the right level', () => {
    expect(togglesToRequireApproval({ anonymous: false, authenticated: false })).toBe('none')
    expect(togglesToRequireApproval({ anonymous: true, authenticated: false })).toBe('anonymous')
    expect(togglesToRequireApproval({ anonymous: false, authenticated: true })).toBe(
      'authenticated'
    )
    expect(togglesToRequireApproval({ anonymous: true, authenticated: true })).toBe('all')
  })

  it('round-trips every level (toggles -> level -> toggles is identity)', () => {
    for (const level of LEVELS) {
      expect(togglesToRequireApproval(requireApprovalToToggles(level))).toBe(level)
    }
  })
})
