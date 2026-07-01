import { describe, it, expect } from 'vitest'
import {
  PERMISSIONS,
  ALL_PERMISSIONS,
  PERMISSION_CATALOGUE,
  PERMISSION_CATEGORIES,
  WORKSPACE_ADMIN_PERMISSIONS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_DEFS,
  SYSTEM_ROLE_PERMISSIONS,
  presetForLegacyRole,
} from '../rbac-catalogue'

const asSet = (xs: readonly string[]) => new Set(xs)

describe('RBAC permission catalogue', () => {
  it('has no duplicate permission keys', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length)
  })

  it('the catalogue is a bijection with PERMISSIONS', () => {
    const catalogueKeys = PERMISSION_CATALOGUE.map((p) => p.key)
    expect(new Set(catalogueKeys).size).toBe(catalogueKeys.length) // no dups
    expect(asSet(catalogueKeys)).toEqual(asSet(ALL_PERMISSIONS))
    expect(PERMISSION_CATALOGUE.length).toBe(ALL_PERMISSIONS.length)
  })

  it('every catalogue entry has a known category and a description', () => {
    for (const p of PERMISSION_CATALOGUE) {
      expect(PERMISSION_CATEGORIES).toContain(p.category)
      expect(p.description.length).toBeGreaterThan(0)
    }
  })

  it('the workspace-admin boundary is a subset with no duplicates', () => {
    expect(new Set(WORKSPACE_ADMIN_PERMISSIONS).size).toBe(WORKSPACE_ADMIN_PERMISSIONS.length)
    for (const p of WORKSPACE_ADMIN_PERMISSIONS) expect(ALL_PERMISSIONS).toContain(p)
  })

  it('Owner is the whole catalogue', () => {
    expect(asSet(SYSTEM_ROLE_PERMISSIONS.owner)).toEqual(asSet(ALL_PERMISSIONS))
  })

  it('Admin is everything except billing', () => {
    expect(asSet(SYSTEM_ROLE_PERMISSIONS.admin)).toEqual(
      asSet(ALL_PERMISSIONS.filter((p) => p !== PERMISSIONS.BILLING_MANAGE))
    )
    expect(SYSTEM_ROLE_PERMISSIONS.admin).not.toContain(PERMISSIONS.BILLING_MANAGE)
  })

  it('Manager is everything except the workspace-admin set (non-regressing reads kept)', () => {
    expect(asSet(SYSTEM_ROLE_PERMISSIONS.manager)).toEqual(
      asSet(ALL_PERMISSIONS.filter((p) => !WORKSPACE_ADMIN_PERMISSIONS.includes(p)))
    )
    // The reads a legacy `member` keeps must survive the mapping.
    expect(SYSTEM_ROLE_PERMISSIONS.manager).toContain(PERMISSIONS.MEMBER_VIEW)
    expect(SYSTEM_ROLE_PERMISSIONS.manager).toContain(PERMISSIONS.INTEGRATION_VIEW)
    // ...but never the workspace-admin writes.
    expect(SYSTEM_ROLE_PERMISSIONS.manager).not.toContain(PERMISSIONS.MEMBER_MANAGE)
    expect(SYSTEM_ROLE_PERMISSIONS.manager).not.toContain(PERMISSIONS.INTEGRATION_MANAGE)
    expect(SYSTEM_ROLE_PERMISSIONS.manager).not.toContain(PERMISSIONS.SETTINGS_MANAGE)
  })

  it('Contributor is a deduped subset that stops at the config boundary', () => {
    const c = SYSTEM_ROLE_PERMISSIONS.contributor
    expect(new Set(c).size).toBe(c.length)
    for (const p of c) expect(ALL_PERMISSIONS).toContain(p)
    // Operates feedback + inbox...
    expect(c).toContain(PERMISSIONS.POST_MODERATE)
    expect(c).toContain(PERMISSIONS.CONVERSATION_REPLY)
    // ...but does not configure product structure or settings.
    expect(c).not.toContain(PERMISSIONS.BOARD_MANAGE)
    expect(c).not.toContain(PERMISSIONS.SETTINGS_MANAGE)
    expect(c).not.toContain(PERMISSIONS.SEGMENT_MANAGE)
  })

  it('there are exactly four system roles with matching defs and bundles', () => {
    const roleKeys = Object.values(SYSTEM_ROLES)
    expect(roleKeys.length).toBe(4)
    expect(asSet(SYSTEM_ROLE_DEFS.map((r) => r.key))).toEqual(asSet(roleKeys))
    expect(asSet(Object.keys(SYSTEM_ROLE_PERMISSIONS))).toEqual(asSet(roleKeys))
  })

  it('maps the legacy roles non-regressively', () => {
    expect(presetForLegacyRole('admin')).toBe(SYSTEM_ROLES.OWNER)
    expect(presetForLegacyRole('member')).toBe(SYSTEM_ROLES.MANAGER)
    expect(presetForLegacyRole('user')).toBeNull()
    expect(presetForLegacyRole('anything-else')).toBeNull()
  })

  it('carries the granular operator keys (Phase 1 additive)', () => {
    // The post.moderate umbrella is split into field-level keys; both coexist
    // until the Phase 3 gate conversion removes the umbrella.
    for (const key of [
      PERMISSIONS.POST_EDIT,
      PERMISSIONS.POST_DELETE,
      PERMISSIONS.POST_SET_STATUS,
      PERMISSIONS.POST_SET_BOARD,
      PERMISSIONS.POST_SET_TAGS,
      PERMISSIONS.POST_SET_OWNER,
      PERMISSIONS.POST_SET_AUTHOR,
      PERMISSIONS.POST_MERGE,
      PERMISSIONS.COMMENT_EDIT,
      PERMISSIONS.COMMENT_PIN,
      PERMISSIONS.CONVERSATION_SET_STATUS,
      PERMISSIONS.CONVERSATION_SET_TAGS,
      PERMISSIONS.CONVERSATION_MANAGE_TAGS,
      PERMISSIONS.SETTINGS_BRANDING,
      PERMISSIONS.SETTINGS_MODERATION,
    ]) {
      expect(ALL_PERMISSIONS).toContain(key)
    }
    expect(PERMISSION_CATEGORIES).toContain('survey')
  })

  it('keeps Manager out of the split settings keys', () => {
    for (const key of [
      PERMISSIONS.SETTINGS_BRANDING,
      PERMISSIONS.SETTINGS_MODERATION,
      PERMISSIONS.SETTINGS_NOTIFICATIONS,
      PERMISSIONS.SETTINGS_CUSTOM_DOMAIN,
    ]) {
      expect(WORKSPACE_ADMIN_PERMISSIONS).toContain(key)
      expect(SYSTEM_ROLE_PERMISSIONS.manager).not.toContain(key)
    }
  })

  it('support permissions are membership-scoped, not flat ticket capabilities', () => {
    // Inbox VERBS are the shared conversation.* set, scoped by team membership; the flat
    // ticket.reply/note/assign/view_* keys were the wrong shape and are removed.
    for (const gone of [
      'ticket.view_all',
      'ticket.view_assigned',
      'ticket.reply',
      'ticket.note',
      'ticket.assign',
      'inbox.manage',
    ]) {
      expect(ALL_PERMISSIONS).not.toContain(gone)
    }
    // The cross-team view-scope override + ticket-lifecycle + renamed channel key exist.
    expect(ALL_PERMISSIONS).toContain(PERMISSIONS.CONVERSATION_VIEW_ALL)
    expect(ALL_PERMISSIONS).toContain(PERMISSIONS.TICKET_MANAGE_TYPES)
    expect(ALL_PERMISSIONS).toContain(PERMISSIONS.CHANNEL_ACCOUNT_MANAGE)
    // Support infrastructure config is admin-only; Manager operates but does not configure it.
    for (const key of [
      PERMISSIONS.SLA_MANAGE,
      PERMISSIONS.ROUTING_MANAGE,
      PERMISSIONS.TEAM_MANAGE,
      PERMISSIONS.CHANNEL_ACCOUNT_MANAGE,
    ]) {
      expect(WORKSPACE_ADMIN_PERMISSIONS).toContain(key)
      expect(SYSTEM_ROLE_PERMISSIONS.manager).not.toContain(key)
    }
  })
})
