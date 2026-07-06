/**
 * Shared entity options for the fullscreen workflow builder (support platform
 * §4.6): teammates, teams, tags, live SLA policies, and live attribute
 * definitions, plus the id -> display name lookups the canvas card summaries
 * and outline rows need. One provider so the canvas, outline, and inspector
 * all read the same cached queries instead of each firing their own.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTeamMembers } from '@/lib/client/hooks/use-team-members'
import { useInboxTeams } from '@/components/admin/conversation/inbox-nav-sidebar'
import { fetchConversationTagsFn } from '@/lib/server/functions/conversation-tags'
import { listSlaPolicyOptionsFn } from '@/lib/server/functions/sla'
import {
  conversationAttributeQueries,
  type ConversationAttributeItem,
} from '@/lib/client/queries/conversation-attributes'
import type { EntityLabels } from '../workflow-graph'

export interface EntityOption {
  id: string
  name: string
}

export interface WorkflowEntities {
  members: EntityOption[]
  teams: EntityOption[]
  tags: EntityOption[]
  /** Live SLA policies for the Apply-SLA picker, with their targets line. */
  slaPolicies: { id: string; name: string; targetsSummary: string }[]
  /** Live attribute definitions (full shape: the value editor needs field
   *  type + options, not just id/name). */
  attributes: ConversationAttributeItem[]
  labels: EntityLabels
}

const WorkflowEntitiesContext = createContext<WorkflowEntities | null>(null)

export function useWorkflowEntities(): WorkflowEntities {
  const ctx = useContext(WorkflowEntitiesContext)
  if (!ctx) throw new Error('useWorkflowEntities must be used inside WorkflowEntitiesProvider')
  return ctx
}

const toMap = (items: EntityOption[]) => new Map(items.map((i) => [i.id, i.name]))

export function WorkflowEntitiesProvider({ children }: { children: ReactNode }) {
  const { data: members } = useTeamMembers()
  const { data: teams } = useInboxTeams()
  const { data: tags } = useQuery({
    queryKey: ['admin', 'conversation-tags', 'all'],
    queryFn: () => fetchConversationTagsFn(),
    staleTime: 60_000,
  })
  const { data: slaPolicies } = useQuery({
    queryKey: ['admin', 'sla-policy-options'],
    queryFn: () => listSlaPolicyOptionsFn(),
    staleTime: 60_000,
  })
  const { data: attributes } = useQuery(conversationAttributeQueries.live())

  const value = useMemo<WorkflowEntities>(() => {
    const memberOptions = (members ?? []).map((m) => ({ id: m.id, name: m.name ?? 'Unnamed' }))
    const teamOptions = (teams ?? []).map((t) => ({ id: t.id, name: t.name }))
    const tagOptions = (tags ?? []).map((t) => ({ id: t.id, name: t.name }))
    const slaOptions = slaPolicies ?? []
    return {
      members: memberOptions,
      teams: teamOptions,
      tags: tagOptions,
      slaPolicies: slaOptions,
      attributes: attributes ?? [],
      labels: {
        members: toMap(memberOptions),
        teams: toMap(teamOptions),
        tags: toMap(tagOptions),
        slaPolicies: toMap(slaOptions),
      },
    }
  }, [members, teams, tags, slaPolicies, attributes])

  return (
    <WorkflowEntitiesContext.Provider value={value}>{children}</WorkflowEntitiesContext.Provider>
  )
}
