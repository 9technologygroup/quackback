import type { IntegrationDefinition } from '../types'
import { archiveTrelloCard } from './archive'
import { listTrelloBoards, listTrelloLists } from './boards'
import { fetchTrelloStatuses } from './statuses'
import { trelloHook } from './hook'
import { getTrelloOAuthUrl, exchangeTrelloCode } from './oauth'
import { trelloCatalog } from './catalog'
import { trelloInboundHandler } from './inbound'

export const trelloIntegration: IntegrationDefinition = {
  id: 'trello',
  catalog: trelloCatalog,
  oauth: {
    stateType: 'trello_oauth',
    buildAuthUrl: getTrelloOAuthUrl,
    exchangeCode: exchangeTrelloCode,
  },
  hook: trelloHook,
  inbound: trelloInboundHandler,
  archive: archiveTrelloCard,
  webhookRegistration: 'manual',
  listExternalStatuses: fetchTrelloStatuses,
  destinations: {
    board: {
      label: 'Board',
      list: async ({ accessToken, config }) => {
        const apiKey = config.apiKey as string
        return listTrelloBoards(apiKey, accessToken)
      },
    },
    list: {
      label: 'List',
      childOf: 'board',
      list: async ({ accessToken, config, parentId }) => {
        if (!parentId) return []
        const apiKey = config.apiKey as string
        return listTrelloLists(apiKey, accessToken, parentId)
      },
    },
  },
  platformCredentials: [
    {
      key: 'clientId',
      label: 'API Key',
      sensitive: false,
      helpUrl: 'https://trello.com/power-ups/admin',
    },
    {
      key: 'clientSecret',
      label: 'API Secret',
      sensitive: true,
      helpUrl: 'https://trello.com/power-ups/admin',
    },
  ],
}
