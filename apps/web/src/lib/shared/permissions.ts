/**
 * Client-safe mirror of the RBAC permission catalogue.
 *
 * The widget/portal client bundles can't import `@quackback/db` (it drags in
 * postgres), so the catalogue is duplicated here as plain data for the admin UI
 * and `<PermissionGate>`. A drift test (permissions-catalogue-drift.test.ts)
 * asserts this stays identical to the `@quackback/db` source of truth: edit the
 * catalogue there first, then mirror the change here.
 */

export const PERMISSIONS = {
  // workspace
  SETTINGS_MANAGE: 'settings.manage',
  BILLING_MANAGE: 'billing.manage',
  ROLE_MANAGE: 'role.manage',
  API_KEY_MANAGE: 'api_key.manage',
  WEBHOOK_VIEW: 'webhook.view',
  WEBHOOK_MANAGE: 'webhook.manage',
  AUTH_MANAGE: 'auth.manage',
  AUDIT_VIEW: 'audit.view',

  // members
  MEMBER_VIEW: 'member.view',
  MEMBER_MANAGE: 'member.manage',

  // people
  PEOPLE_VIEW: 'people.view',
  PEOPLE_MANAGE: 'people.manage',

  // company
  COMPANY_VIEW: 'company.view',
  COMPANY_MANAGE: 'company.manage',

  // audience
  SEGMENT_VIEW: 'segment.view',
  SEGMENT_MANAGE: 'segment.manage',
  USER_ATTRIBUTE_VIEW: 'user_attribute.view',
  USER_ATTRIBUTE_MANAGE: 'user_attribute.manage',

  // feedback
  POST_VIEW_PRIVATE: 'post.view_private',
  POST_CREATE: 'post.create',
  POST_MODERATE: 'post.moderate',
  POST_APPROVE: 'post.approve',
  POST_VOTE_ON_BEHALF: 'post.vote_on_behalf',
  COMMENT_MODERATE: 'comment.moderate',
  BOARD_MANAGE: 'board.manage',
  ROADMAP_MANAGE: 'roadmap.manage',
  STATUS_VIEW: 'status.view',
  STATUS_MANAGE: 'status.manage',
  TAG_VIEW: 'tag.view',
  TAG_MANAGE: 'tag.manage',
  SUGGESTION_VIEW: 'suggestion.view',
  SUGGESTION_MANAGE: 'suggestion.manage',

  // changelog
  CHANGELOG_VIEW_DRAFT: 'changelog.view_draft',
  CHANGELOG_MANAGE: 'changelog.manage',

  // help_center
  HELP_CENTER_MANAGE: 'help_center.manage',

  // conversation
  CONVERSATION_VIEW: 'conversation.view',
  CONVERSATION_REPLY: 'conversation.reply',
  CONVERSATION_NOTE: 'conversation.note',
  CONVERSATION_ASSIGN: 'conversation.assign',
  CONVERSATION_MANAGE: 'conversation.manage',

  // analytics
  ANALYTICS_VIEW: 'analytics.view',

  // integration
  INTEGRATION_VIEW: 'integration.view',
  INTEGRATION_MANAGE: 'integration.manage',

  // support (dormant until the support platform lands)
  TICKET_VIEW_ALL: 'ticket.view_all',
  TICKET_VIEW_ASSIGNED: 'ticket.view_assigned',
  TICKET_REPLY: 'ticket.reply',
  TICKET_NOTE: 'ticket.note',
  TICKET_ASSIGN: 'ticket.assign',
  SLA_MANAGE: 'sla.manage',
  INBOX_MANAGE: 'inbox.manage',
  ROUTING_MANAGE: 'routing.manage',
  TEAM_MANAGE: 'team.manage',
} as const

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as PermissionKey[]

export const PERMISSION_CATEGORIES = [
  'workspace',
  'members',
  'people',
  'company',
  'audience',
  'feedback',
  'changelog',
  'help_center',
  'conversation',
  'analytics',
  'integration',
  'support',
] as const

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number]

// --------------------------------------------------------------- presets ---
// Mirrored from @quackback/db (the drift test enforces equality). The policy
// layer resolves an actor's permissions from these, and the read-only Roles UI
// renders them, so they must be client-safe.

export const SYSTEM_ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MANAGER: 'manager',
  CONTRIBUTOR: 'contributor',
} as const

export type SystemRoleKey = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES]

export const WORKSPACE_ADMIN_PERMISSIONS: readonly PermissionKey[] = [
  PERMISSIONS.SETTINGS_MANAGE,
  PERMISSIONS.BILLING_MANAGE,
  PERMISSIONS.MEMBER_MANAGE,
  PERMISSIONS.ROLE_MANAGE,
  PERMISSIONS.API_KEY_MANAGE,
  PERMISSIONS.WEBHOOK_VIEW,
  PERMISSIONS.WEBHOOK_MANAGE,
  PERMISSIONS.AUTH_MANAGE,
  PERMISSIONS.INTEGRATION_MANAGE,
  PERMISSIONS.AUDIT_VIEW,
]

export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleKey, PermissionKey[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS.filter((p) => p !== PERMISSIONS.BILLING_MANAGE),
  manager: ALL_PERMISSIONS.filter((p) => !WORKSPACE_ADMIN_PERMISSIONS.includes(p)),
  contributor: [
    PERMISSIONS.POST_VIEW_PRIVATE,
    PERMISSIONS.POST_CREATE,
    PERMISSIONS.POST_MODERATE,
    PERMISSIONS.POST_APPROVE,
    PERMISSIONS.POST_VOTE_ON_BEHALF,
    PERMISSIONS.COMMENT_MODERATE,
    PERMISSIONS.CHANGELOG_VIEW_DRAFT,
    PERMISSIONS.CONVERSATION_VIEW,
    PERMISSIONS.CONVERSATION_REPLY,
    PERMISSIONS.CONVERSATION_NOTE,
    PERMISSIONS.CONVERSATION_ASSIGN,
    PERMISSIONS.PEOPLE_VIEW,
    PERMISSIONS.COMPANY_VIEW,
    PERMISSIONS.MEMBER_VIEW,
    PERMISSIONS.SEGMENT_VIEW,
    PERMISSIONS.INTEGRATION_VIEW,
    PERMISSIONS.ANALYTICS_VIEW,
    PERMISSIONS.STATUS_VIEW,
    PERMISSIONS.TAG_VIEW,
    PERMISSIONS.SUGGESTION_VIEW,
    PERMISSIONS.SUGGESTION_MANAGE,
  ],
}

/** Legacy `principal.role` -> system role preset (admin -> Owner, member ->
 *  Manager, everything else -> none). */
export function presetForLegacyRole(role: string): SystemRoleKey | null {
  if (role === 'admin') return SYSTEM_ROLES.OWNER
  if (role === 'member') return SYSTEM_ROLES.MANAGER
  return null
}

/**
 * Each permission's category, for the read-only Roles matrix UI. The
 * (key, category) pairs mirror @quackback/db's PERMISSION_CATALOGUE; the drift
 * test enforces the projection. Descriptions live only in the db catalogue.
 */
export const PERMISSION_CATALOGUE: ReadonlyArray<{
  key: PermissionKey
  category: PermissionCategory
}> = [
  { key: PERMISSIONS.SETTINGS_MANAGE, category: 'workspace' },
  { key: PERMISSIONS.BILLING_MANAGE, category: 'workspace' },
  { key: PERMISSIONS.ROLE_MANAGE, category: 'workspace' },
  { key: PERMISSIONS.API_KEY_MANAGE, category: 'workspace' },
  { key: PERMISSIONS.WEBHOOK_VIEW, category: 'workspace' },
  { key: PERMISSIONS.WEBHOOK_MANAGE, category: 'workspace' },
  { key: PERMISSIONS.AUTH_MANAGE, category: 'workspace' },
  { key: PERMISSIONS.AUDIT_VIEW, category: 'workspace' },
  { key: PERMISSIONS.MEMBER_VIEW, category: 'members' },
  { key: PERMISSIONS.MEMBER_MANAGE, category: 'members' },
  { key: PERMISSIONS.PEOPLE_VIEW, category: 'people' },
  { key: PERMISSIONS.PEOPLE_MANAGE, category: 'people' },
  { key: PERMISSIONS.COMPANY_VIEW, category: 'company' },
  { key: PERMISSIONS.COMPANY_MANAGE, category: 'company' },
  { key: PERMISSIONS.SEGMENT_VIEW, category: 'audience' },
  { key: PERMISSIONS.SEGMENT_MANAGE, category: 'audience' },
  { key: PERMISSIONS.USER_ATTRIBUTE_VIEW, category: 'audience' },
  { key: PERMISSIONS.USER_ATTRIBUTE_MANAGE, category: 'audience' },
  { key: PERMISSIONS.POST_VIEW_PRIVATE, category: 'feedback' },
  { key: PERMISSIONS.POST_CREATE, category: 'feedback' },
  { key: PERMISSIONS.POST_MODERATE, category: 'feedback' },
  { key: PERMISSIONS.POST_APPROVE, category: 'feedback' },
  { key: PERMISSIONS.POST_VOTE_ON_BEHALF, category: 'feedback' },
  { key: PERMISSIONS.COMMENT_MODERATE, category: 'feedback' },
  { key: PERMISSIONS.BOARD_MANAGE, category: 'feedback' },
  { key: PERMISSIONS.ROADMAP_MANAGE, category: 'feedback' },
  { key: PERMISSIONS.STATUS_VIEW, category: 'feedback' },
  { key: PERMISSIONS.STATUS_MANAGE, category: 'feedback' },
  { key: PERMISSIONS.TAG_VIEW, category: 'feedback' },
  { key: PERMISSIONS.TAG_MANAGE, category: 'feedback' },
  { key: PERMISSIONS.SUGGESTION_VIEW, category: 'feedback' },
  { key: PERMISSIONS.SUGGESTION_MANAGE, category: 'feedback' },
  { key: PERMISSIONS.CHANGELOG_VIEW_DRAFT, category: 'changelog' },
  { key: PERMISSIONS.CHANGELOG_MANAGE, category: 'changelog' },
  { key: PERMISSIONS.HELP_CENTER_MANAGE, category: 'help_center' },
  { key: PERMISSIONS.CONVERSATION_VIEW, category: 'conversation' },
  { key: PERMISSIONS.CONVERSATION_REPLY, category: 'conversation' },
  { key: PERMISSIONS.CONVERSATION_NOTE, category: 'conversation' },
  { key: PERMISSIONS.CONVERSATION_ASSIGN, category: 'conversation' },
  { key: PERMISSIONS.CONVERSATION_MANAGE, category: 'conversation' },
  { key: PERMISSIONS.ANALYTICS_VIEW, category: 'analytics' },
  { key: PERMISSIONS.INTEGRATION_VIEW, category: 'integration' },
  { key: PERMISSIONS.INTEGRATION_MANAGE, category: 'integration' },
  { key: PERMISSIONS.TICKET_VIEW_ALL, category: 'support' },
  { key: PERMISSIONS.TICKET_VIEW_ASSIGNED, category: 'support' },
  { key: PERMISSIONS.TICKET_REPLY, category: 'support' },
  { key: PERMISSIONS.TICKET_NOTE, category: 'support' },
  { key: PERMISSIONS.TICKET_ASSIGN, category: 'support' },
  { key: PERMISSIONS.SLA_MANAGE, category: 'support' },
  { key: PERMISSIONS.INBOX_MANAGE, category: 'support' },
  { key: PERMISSIONS.ROUTING_MANAGE, category: 'support' },
  { key: PERMISSIONS.TEAM_MANAGE, category: 'support' },
]

/** The permission set a legacy role resolves to (client-side mirror of the
 *  server resolver) — the source for `<PermissionGate>`. */
export function permissionsForRole(role: string | null): ReadonlySet<PermissionKey> {
  const preset = role ? presetForLegacyRole(role) : null
  return new Set(preset ? SYSTEM_ROLE_PERMISSIONS[preset] : [])
}
