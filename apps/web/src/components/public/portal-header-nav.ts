/**
 * Pure helpers for the portal header's top-level nav.
 * Kept in its own module so tests can import without dragging in React.
 */

const NAV_ITEM_FEEDBACK = {
  to: '/',
  messageId: 'portal.header.nav.feedback',
  defaultMessage: 'Feedback',
} as const

const NAV_ITEM_ROADMAP = {
  to: '/roadmap',
  messageId: 'portal.header.nav.roadmap',
  defaultMessage: 'Roadmap',
} as const

const NAV_ITEM_CHANGELOG = {
  to: '/changelog',
  messageId: 'portal.header.nav.changelog',
  defaultMessage: 'Changelog',
} as const

const NAV_ITEM_HELP = {
  to: '/hc',
  messageId: 'portal.header.nav.help',
  defaultMessage: 'Help Center',
} as const

const NAV_ITEM_SUPPORT = {
  to: '/support',
  messageId: 'portal.header.nav.support',
  defaultMessage: 'Support',
} as const

const NAV_ITEM_STATUS = {
  to: '/status',
  messageId: 'portal.header.nav.status',
  defaultMessage: 'Status',
} as const

export type PortalNavItem =
  | typeof NAV_ITEM_FEEDBACK
  | typeof NAV_ITEM_ROADMAP
  | typeof NAV_ITEM_CHANGELOG
  | typeof NAV_ITEM_HELP
  | typeof NAV_ITEM_SUPPORT
  | typeof NAV_ITEM_STATUS

/**
 * Returns the nav items shown in the portal header.
 * Feedback and its roadmap appear when the Feedback product is enabled.
 * Changelog also respects its portal-tab setting. Help, Support, and Status
 * retain their publication controls beneath workspace product availability.
 * Enablement already folds in the viewer's audience gate, so the tab only
 * renders for a viewer who can see the page.
 */
export function buildNavItems({
  feedbackEnabled = true,
  helpCenterEnabled,
  supportEnabled,
  changelogEnabled = true,
  statusEnabled = false,
}: {
  feedbackEnabled?: boolean
  helpCenterEnabled: boolean
  supportEnabled: boolean
  changelogEnabled?: boolean
  statusEnabled?: boolean
}): readonly PortalNavItem[] {
  const items: PortalNavItem[] = []
  if (feedbackEnabled) items.push(NAV_ITEM_FEEDBACK, NAV_ITEM_ROADMAP)
  if (changelogEnabled) items.push(NAV_ITEM_CHANGELOG)
  if (helpCenterEnabled) items.push(NAV_ITEM_HELP)
  if (supportEnabled) items.push(NAV_ITEM_SUPPORT)
  if (statusEnabled) items.push(NAV_ITEM_STATUS)
  return items
}
