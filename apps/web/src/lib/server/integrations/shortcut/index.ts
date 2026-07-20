import type { IntegrationDefinition } from '../types'
import { archiveShortcutStory } from './archive'
import { fetchShortcutStates } from './statuses'
import { shortcutHook } from './hook'
import { shortcutInboundHandler } from './inbound'
import { shortcutCatalog } from './catalog'
import { listShortcutProjects } from './projects'

export const shortcutIntegration: IntegrationDefinition = {
  id: 'shortcut',
  catalog: shortcutCatalog,
  destinations: {
    project: {
      label: 'Project',
      list: async ({ accessToken }) => {
        const projects = await listShortcutProjects(accessToken)
        return projects.map((p) => ({ id: String(p.id), name: p.name }))
      },
    },
  },
  hook: shortcutHook,
  inbound: shortcutInboundHandler,
  archive: archiveShortcutStory,
  webhookRegistration: 'manual',
  listExternalStatuses: fetchShortcutStates,
  platformCredentials: [],
}
