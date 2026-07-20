import type { IntegrationDefinition } from '../types'
import { archiveMondayItem } from './archive'
import { mondayHook } from './hook'
import { getMondayOAuthUrl, exchangeMondayCode } from './oauth'
import { mondayCatalog } from './catalog'
import { listMondayBoards } from './boards'

export const mondayIntegration: IntegrationDefinition = {
  id: 'monday',
  catalog: mondayCatalog,
  oauth: {
    stateType: 'monday_oauth',
    buildAuthUrl: getMondayOAuthUrl,
    exchangeCode: exchangeMondayCode,
  },
  destinations: {
    board: {
      label: 'Board',
      list: async ({ accessToken }) => {
        const boards = await listMondayBoards(accessToken)
        return boards.map((b) => ({ id: String(b.id), name: b.name }))
      },
    },
  },
  hook: mondayHook,
  archive: archiveMondayItem,
  platformCredentials: [
    {
      key: 'clientId',
      label: 'Client ID',
      sensitive: false,
      helpUrl: 'https://developer.monday.com/apps/manage',
    },
    {
      key: 'clientSecret',
      label: 'Client Secret',
      sensitive: true,
      helpUrl: 'https://developer.monday.com/apps/manage',
    },
  ],
}
