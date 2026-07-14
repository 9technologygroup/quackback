import { z } from 'zod'
import { assistantRoleSchema, type AssistantRole } from './config'

export const ASSISTANT_GUIDANCE_NAME_MAX_LENGTH = 80
export const ASSISTANT_GUIDANCE_APPLIES_WHEN_MAX_LENGTH = 500
export const ASSISTANT_GUIDANCE_INSTRUCTION_MAX_LENGTH = 1_000
export const ASSISTANT_GUIDANCE_MAX_ENABLED_CANDIDATES = 25
export const ASSISTANT_GUIDANCE_MAX_SELECTED_CONDITIONAL = 5
export const ASSISTANT_GUIDANCE_CHAR_BUDGET = 4_000

export const DEFAULT_ASSISTANT_GUIDANCE_ROLES = [
  'customer_support',
  'suggested_reply',
] as const satisfies readonly AssistantRole[]

/** Removes unsafe ASCII controls while preserving intentional tabs, newlines, and Unicode. */
export function normalizeGuidanceText(value: string): string {
  let normalized = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    const removed = (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f
    if (!removed) normalized += character
  }
  return normalized.trim()
}

const normalizedRequiredText = (label: string, maxLength: number) =>
  z
    .string()
    .transform(normalizeGuidanceText)
    .pipe(
      z
        .string()
        .min(1, `${label} is required`)
        .max(maxLength, `${label} must be ${maxLength} characters or fewer`)
    )

export const assistantGuidanceNameSchema = normalizedRequiredText(
  'Name',
  ASSISTANT_GUIDANCE_NAME_MAX_LENGTH
)
export const assistantGuidanceInstructionSchema = normalizedRequiredText(
  'Instruction',
  ASSISTANT_GUIDANCE_INSTRUCTION_MAX_LENGTH
)
const normalizedGuidanceAppliesWhenSchema = z
  .string()
  .nullable()
  .transform((value) => (value === null ? null : normalizeGuidanceText(value) || null))
  .pipe(
    z
      .string()
      .min(1)
      .max(
        ASSISTANT_GUIDANCE_APPLIES_WHEN_MAX_LENGTH,
        `Condition must be ${ASSISTANT_GUIDANCE_APPLIES_WHEN_MAX_LENGTH} characters or fewer`
      )
      .nullable()
  )

export const assistantGuidanceAppliesWhenSchema = normalizedGuidanceAppliesWhenSchema
  .optional()
  .transform((value) => value ?? null)

export const assistantGuidanceRoleSchema = assistantRoleSchema

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

export const assistantGuidanceRolesSchema = z
  .array(assistantGuidanceRoleSchema)
  .min(1, 'Select at least one role')
  .max(3)
  .refine(hasUniqueValues, 'Roles must be unique')

export const assistantGuidanceRuleInputSchema = z.object({
  name: assistantGuidanceNameSchema,
  appliesWhen: assistantGuidanceAppliesWhenSchema,
  instruction: assistantGuidanceInstructionSchema,
  roles: assistantGuidanceRolesSchema.default(() => [...DEFAULT_ASSISTANT_GUIDANCE_ROLES]),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
})

export const assistantGuidanceRulePatchSchema = z.object({
  name: assistantGuidanceNameSchema.optional(),
  appliesWhen: normalizedGuidanceAppliesWhenSchema.optional(),
  instruction: assistantGuidanceInstructionSchema.optional(),
  roles: assistantGuidanceRolesSchema.optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
})

/** Client-safe representation of the persisted V2 rule. */
export const assistantGuidanceRuleSchema = z.object({
  id: z.string(),
  name: assistantGuidanceNameSchema,
  appliesWhen: normalizedGuidanceAppliesWhenSchema,
  instruction: assistantGuidanceInstructionSchema,
  roles: assistantGuidanceRolesSchema,
  enabled: z.boolean(),
  priority: z.number().int(),
  createdById: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type AssistantGuidanceRuleInput = z.input<typeof assistantGuidanceRuleInputSchema>
export type NormalizedAssistantGuidanceRuleInput = z.output<typeof assistantGuidanceRuleInputSchema>
export type AssistantGuidanceRulePatch = z.input<typeof assistantGuidanceRulePatchSchema>
export type AssistantGuidanceRole = AssistantRole

export interface GuidanceInstruction {
  instruction: string
}

/** Keeps whole instructions within the block budget, skipping oversized rules instead of stopping. */
export function applyGuidanceBudget<T extends GuidanceInstruction>(
  rules: readonly T[],
  budget = ASSISTANT_GUIDANCE_CHAR_BUDGET
): T[] {
  const selected: T[] = []
  let used = 0

  for (const rule of rules) {
    if (used + rule.instruction.length > budget) continue
    selected.push(rule)
    used += rule.instruction.length
  }

  return selected
}
