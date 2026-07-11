import { useRouteContext } from '@tanstack/react-router'
import { useCopilotTabGate } from './use-copilot-tab-gate'
import type { FeatureFlags } from '@/lib/shared/types/settings'

/**
 * Whether the proactive suggested-reply card (QUINN-PROACTIVE-SUGGESTIONS-SPEC.md)
 * may render for this viewer: the SAME gate the Copilot tab uses
 * (`useCopilotTabGate` — `assistantCopilot` flag + `copilot.use` permission)
 * PLUS the new `assistantProactiveSuggestions` flag. A suggestion is
 * agent-facing assist drafted from the same read-only turn the Copilot panel
 * runs, so it never exists somewhere the panel itself couldn't also reach.
 */
export function useSuggestedReplyGate(): boolean {
  const { settings } = useRouteContext({ from: '/admin' }) as {
    settings?: { featureFlags?: FeatureFlags } | null
  }
  const copilotGate = useCopilotTabGate()
  return copilotGate && !!settings?.featureFlags?.assistantProactiveSuggestions
}
