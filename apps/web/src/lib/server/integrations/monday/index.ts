import type { IntegrationDefinition } from '../types'
import { archiveMondayItem } from './archive'
import { mondayHook } from './hook'
import { getMondayOAuthUrl, exchangeMondayCode } from './oauth'
import { mondayCatalog } from './catalog'

export const mondayIntegration: IntegrationDefinition = {
  id: 'monday',
  catalog: mondayCatalog,
  oauth: {
    stateType: 'monday_oauth',
    buildAuthUrl: getMondayOAuthUrl,
    exchangeCode: exchangeMondayCode,
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
