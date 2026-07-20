import type { IntegrationDefinition } from '../types'
import { closeGitLabIssue } from './archive'
import { fetchGitLabStatuses } from './statuses'
import { gitlabHook } from './hook'
import { getGitLabOAuthUrl, exchangeGitLabCode } from './oauth'
import { gitlabCatalog } from './catalog'
import { gitlabInboundHandler } from './inbound'
import { listGitLabProjects } from './projects'

export const gitlabIntegration: IntegrationDefinition = {
  id: 'gitlab',
  catalog: gitlabCatalog,
  oauth: {
    stateType: 'gitlab_oauth',
    buildAuthUrl: getGitLabOAuthUrl,
    exchangeCode: exchangeGitLabCode,
  },
  destinations: {
    project: {
      label: 'Project',
      list: async ({ accessToken }) => {
        const projects = await listGitLabProjects(accessToken)
        return projects.map((p) => ({ id: String(p.id), name: p.name }))
      },
    },
  },
  hook: gitlabHook,
  inbound: gitlabInboundHandler,
  archive: closeGitLabIssue,
  webhookRegistration: 'manual',
  listExternalStatuses: fetchGitLabStatuses,
  platformCredentials: [
    {
      key: 'clientId',
      label: 'Application ID',
      sensitive: false,
      helpUrl: 'https://gitlab.com/-/user_settings/applications',
    },
    {
      key: 'clientSecret',
      label: 'Secret',
      sensitive: true,
      helpUrl: 'https://gitlab.com/-/user_settings/applications',
    },
  ],
}
