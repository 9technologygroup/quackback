import { z } from 'zod'

export const ASSISTANT_CONFIG_VERSION = 2 as const
export const ASSISTANT_NAME_MAX_LENGTH = 80
export const ASSISTANT_AVATAR_URL_MAX_LENGTH = 2_000
export const ASSISTANT_ADDITIONAL_INSTRUCTIONS_MAX_LENGTH = 2_000

export const ASSISTANT_TONES = ['warm', 'balanced', 'professional'] as const
export const ASSISTANT_RESPONSE_LENGTHS = ['brief', 'balanced', 'detailed'] as const

export const assistantToneSchema = z.enum(ASSISTANT_TONES)
export const assistantResponseLengthSchema = z.enum(ASSISTANT_RESPONSE_LENGTHS)

export type AssistantTone = z.infer<typeof assistantToneSchema>
export type AssistantResponseLength = z.infer<typeof assistantResponseLengthSchema>

function isHttpUrl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f) return false
  }

  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export const assistantAvatarUrlSchema = z
  .string()
  .trim()
  .url()
  .max(ASSISTANT_AVATAR_URL_MAX_LENGTH)
  .refine(isHttpUrl, { message: 'Avatar URL must use HTTP or HTTPS' })

export const assistantIdentitySchema = z.object({
  name: z.string().trim().min(1).max(ASSISTANT_NAME_MAX_LENGTH),
  avatarUrl: assistantAvatarUrlSchema.nullable(),
})

export const assistantVoiceSchema = z.object({
  tone: assistantToneSchema,
  responseLength: assistantResponseLengthSchema,
  additionalInstructions: z.string().max(ASSISTANT_ADDITIONAL_INSTRUCTIONS_MAX_LENGTH),
})

export const assistantConfigSchema = z.object({
  version: z.literal(ASSISTANT_CONFIG_VERSION),
  identity: assistantIdentitySchema,
  voice: assistantVoiceSchema,
})

export type AssistantIdentity = z.infer<typeof assistantIdentitySchema>
export type AssistantVoice = z.infer<typeof assistantVoiceSchema>
export type AssistantConfig = z.infer<typeof assistantConfigSchema>

export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  version: ASSISTANT_CONFIG_VERSION,
  identity: {
    name: 'Quinn',
    avatarUrl: null,
  },
  voice: {
    tone: 'balanced',
    responseLength: 'balanced',
    additionalInstructions: '',
  },
}

export interface AssistantPresetDefinition<Value extends string> {
  id: Value
  labelMessageId: string
  descriptionMessageId: string
  directive: string
}

type AssistantPresetCatalogue<Value extends string> = {
  readonly [Preset in Value]: AssistantPresetDefinition<Preset>
}

export const ASSISTANT_TONE_CATALOGUE = {
  warm: {
    id: 'warm',
    labelMessageId: 'assistant.voice.tone.warm.label',
    descriptionMessageId: 'assistant.voice.tone.warm.description',
    directive:
      'Use a warm, approachable tone. Be empathetic without over-apologizing or sounding overly enthusiastic.',
  },
  balanced: {
    id: 'balanced',
    labelMessageId: 'assistant.voice.tone.balanced.label',
    descriptionMessageId: 'assistant.voice.tone.balanced.description',
    directive:
      'Use a clear, calm, natural tone. Be friendly without adding unnecessary enthusiasm or formality.',
  },
  professional: {
    id: 'professional',
    labelMessageId: 'assistant.voice.tone.professional.label',
    descriptionMessageId: 'assistant.voice.tone.professional.description',
    directive:
      'Use a polished, professional tone. Stay natural and direct; do not sound legalistic or impersonal.',
  },
} as const satisfies AssistantPresetCatalogue<AssistantTone>

export const ASSISTANT_RESPONSE_LENGTH_CATALOGUE = {
  brief: {
    id: 'brief',
    labelMessageId: 'assistant.voice.responseLength.brief.label',
    descriptionMessageId: 'assistant.voice.responseLength.brief.description',
    directive:
      'Prefer the shortest complete answer. Usually use one short paragraph or a compact list.',
  },
  balanced: {
    id: 'balanced',
    labelMessageId: 'assistant.voice.responseLength.balanced.label',
    descriptionMessageId: 'assistant.voice.responseLength.balanced.description',
    directive:
      'Give enough context to make the answer clear, then state the next step. Avoid unnecessary detail.',
  },
  detailed: {
    id: 'detailed',
    labelMessageId: 'assistant.voice.responseLength.detailed.label',
    descriptionMessageId: 'assistant.voice.responseLength.detailed.description',
    directive:
      'Give a fuller explanation and ordered steps when the request benefits from them. Do not add detail unrelated to the request.',
  },
} as const satisfies AssistantPresetCatalogue<AssistantResponseLength>

export const ASSISTANT_TONE_DIRECTIVES: Record<AssistantTone, string> = {
  warm: ASSISTANT_TONE_CATALOGUE.warm.directive,
  balanced: ASSISTANT_TONE_CATALOGUE.balanced.directive,
  professional: ASSISTANT_TONE_CATALOGUE.professional.directive,
}

export const ASSISTANT_RESPONSE_LENGTH_DIRECTIVES: Record<AssistantResponseLength, string> = {
  brief: ASSISTANT_RESPONSE_LENGTH_CATALOGUE.brief.directive,
  balanced: ASSISTANT_RESPONSE_LENGTH_CATALOGUE.balanced.directive,
  detailed: ASSISTANT_RESPONSE_LENGTH_CATALOGUE.detailed.directive,
}

export const ASSISTANT_ROLES = ['customer_support', 'copilot_qa', 'suggested_reply'] as const
export const assistantRoleSchema = z.enum(ASSISTANT_ROLES)
export type AssistantRole = z.infer<typeof assistantRoleSchema>

export interface AssistantRoleDefinition {
  id: AssistantRole
  labelMessageId: string
  descriptionMessageId: string
}

export type AssistantRoleCatalogue = {
  readonly [Role in AssistantRole]: AssistantRoleDefinition & {
    readonly id: Role
  }
}

export const ASSISTANT_ROLE_CATALOGUE = {
  customer_support: {
    id: 'customer_support',
    labelMessageId: 'assistant.role.customerSupport.label',
    descriptionMessageId: 'assistant.role.customerSupport.description',
  },
  copilot_qa: {
    id: 'copilot_qa',
    labelMessageId: 'assistant.role.copilotQa.label',
    descriptionMessageId: 'assistant.role.copilotQa.description',
  },
  suggested_reply: {
    id: 'suggested_reply',
    labelMessageId: 'assistant.role.suggestedReply.label',
    descriptionMessageId: 'assistant.role.suggestedReply.description',
  },
} as const satisfies AssistantRoleCatalogue

/** Removes unsafe ASCII controls without changing meaningful customer-authored text. */
export function normalizeAssistantText(value: string): string {
  const characters: string[] = []

  for (const character of value) {
    const code = character.charCodeAt(0)
    const isRemovedControl = (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f
    if (!isRemovedControl) characters.push(character)
  }

  return characters.join('').trim()
}

const assistantConfigInputSchema = z.object({
  version: z.literal(ASSISTANT_CONFIG_VERSION),
  identity: z.object({
    name: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  voice: z.object({
    tone: assistantToneSchema,
    responseLength: assistantResponseLengthSchema,
    additionalInstructions: z.string(),
  }),
})

/** Normalizes a complete V2 input, then validates every persisted boundary. */
export function normalizeAssistantConfig(input: unknown): AssistantConfig {
  const parsed = assistantConfigInputSchema.parse(input)

  return assistantConfigSchema.parse({
    ...parsed,
    identity: {
      ...parsed.identity,
      name: normalizeAssistantText(parsed.identity.name),
    },
    voice: {
      ...parsed.voice,
      additionalInstructions: normalizeAssistantText(parsed.voice.additionalInstructions),
    },
  })
}
