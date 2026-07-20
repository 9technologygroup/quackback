import type { IntegrationDefinition } from '../types'
import { archiveShortcutStory } from './archive'
import { shortcutHook } from './hook'
import { shortcutInboundHandler } from './inbound'
import { shortcutCatalog } from './catalog'

export const shortcutIntegration: IntegrationDefinition = {
  id: 'shortcut',
  catalog: shortcutCatalog,
  hook: shortcutHook,
  inbound: shortcutInboundHandler,
  archive: archiveShortcutStory,
  webhookRegistration: 'manual',
  platformCredentials: [],
}
