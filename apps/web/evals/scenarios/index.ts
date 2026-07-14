/**
 * The seed golden set (QUINN-TWO-AGENT-SPEC §7.3, scenarios 1–25). Slots 26–30
 * stay reserved for the first production-signal harvest (§7.5); each later v3
 * phase adds its own (§7.6).
 */
import type { Scenario } from '../types'
import { groundingScenarios } from './grounding'
import { escalationScenarios } from './escalation'
import { safetyScenarios } from './safety'
import { voiceScenarios } from './voice'
import { roleScenarios } from './roles'
import { languageScenarios } from './language'

export const scenarios: Scenario[] = [
  ...groundingScenarios,
  ...escalationScenarios,
  ...safetyScenarios,
  ...voiceScenarios,
  ...roleScenarios,
  ...languageScenarios,
]
