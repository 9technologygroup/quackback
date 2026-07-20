import type { IntegrationDefinition } from '../types'
import { closeAzureDevOpsWorkItem } from './archive'
import { fetchAzureDevOpsStatuses } from './statuses'
import { azureDevOpsHook } from './hook'
import { azureDevOpsInboundHandler } from './inbound'
import { azureDevOpsIssues } from './issues'
import { listProjects, listWorkItemTypes } from './api'
import { azureDevOpsCatalog } from './catalog'

export const azureDevOpsIntegration: IntegrationDefinition = {
  id: 'azure_devops',
  catalog: azureDevOpsCatalog,
  // No OAuth — Azure DevOps uses Personal Access Tokens
  hook: azureDevOpsHook,
  inbound: azureDevOpsInboundHandler,
  issues: azureDevOpsIssues,
  archive: closeAzureDevOpsWorkItem,
  webhookRegistration: 'manual',
  listExternalStatuses: fetchAzureDevOpsStatuses,
  destinations: {
    project: {
      label: 'Project',
      list: async ({ accessToken, config }) => {
        const organizationName = config.organizationName as string
        const projects = await listProjects(accessToken, organizationName)
        // channelId is composed as "projectName:workItemType", so the
        // destination id must be the project NAME, not its GUID.
        return projects.map((p) => ({ id: p.name, name: p.name }))
      },
    },
    'work-item-type': {
      label: 'Work item type',
      childOf: 'project',
      list: async ({ accessToken, config, parentId }) => {
        if (!parentId) return []
        const organizationName = config.organizationName as string
        // parentId is the project NAME (what listWorkItemTypes expects).
        const types = await listWorkItemTypes(accessToken, organizationName, parentId)
        return types.map((t) => ({ id: t.name, name: t.name }))
      },
    },
  },
  platformCredentials: [],
}
