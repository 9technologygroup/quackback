import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_ADDITIONAL_INSTRUCTIONS_MAX_LENGTH,
  ASSISTANT_AVATAR_URL_MAX_LENGTH,
  ASSISTANT_CHANNEL_INSTRUCTIONS_MAX_LENGTH,
  ASSISTANT_NAME_MAX_LENGTH,
  ASSISTANT_RESPONSE_LENGTH_CATALOGUE,
  ASSISTANT_RESPONSE_LENGTH_DIRECTIVES,
  ASSISTANT_RESPONSE_LENGTHS,
  ASSISTANT_ROLE_CATALOGUE,
  ASSISTANT_ROLES,
  ASSISTANT_TONE_CATALOGUE,
  ASSISTANT_TONE_DIRECTIVES,
  ASSISTANT_TONES,
  ASSISTANT_TOOL_CONTROLS,
  DEFAULT_ASSISTANT_CONFIG,
  assistantConfigSchema,
  assistantRoleSchema,
  normalizeAssistantConfig,
  normalizeAssistantText,
  type AssistantConfig,
} from '../config'

function validConfig(): AssistantConfig {
  return structuredClone(DEFAULT_ASSISTANT_CONFIG)
}

describe('assistantConfigSchema', () => {
  it('accepts and preserves the V2 default', () => {
    expect(assistantConfigSchema.parse(DEFAULT_ASSISTANT_CONFIG)).toEqual({
      version: 2,
      identity: {
        name: 'Quinn',
        avatarUrl: null,
        showAiLabel: true,
      },
      voice: {
        tone: 'balanced',
        responseLength: 'balanced',
        additionalInstructions: '',
      },
      channels: {},
      toolControls: {},
    })
  })

  it('enforces the assistant name boundaries after trimming', () => {
    const minimum = validConfig()
    minimum.identity.name = ' Q '
    expect(assistantConfigSchema.parse(minimum).identity.name).toBe('Q')

    const maximum = validConfig()
    maximum.identity.name = ` ${'a'.repeat(ASSISTANT_NAME_MAX_LENGTH)} `
    expect(assistantConfigSchema.parse(maximum).identity.name).toHaveLength(
      ASSISTANT_NAME_MAX_LENGTH
    )

    for (const name of ['', '   ', 'a'.repeat(ASSISTANT_NAME_MAX_LENGTH + 1)]) {
      const config = validConfig()
      config.identity.name = name
      expect(assistantConfigSchema.safeParse(config).success).toBe(false)
    }
  })

  it('enforces global and channel instruction maxima', () => {
    const maximum = validConfig()
    maximum.voice.additionalInstructions = 'a'.repeat(ASSISTANT_ADDITIONAL_INSTRUCTIONS_MAX_LENGTH)
    maximum.channels = {
      widget: {
        additionalInstructions: 'w'.repeat(ASSISTANT_CHANNEL_INSTRUCTIONS_MAX_LENGTH),
      },
      email: {
        additionalInstructions: 'e'.repeat(ASSISTANT_CHANNEL_INSTRUCTIONS_MAX_LENGTH),
      },
    }
    expect(assistantConfigSchema.safeParse(maximum).success).toBe(true)

    const globalOver = validConfig()
    globalOver.voice.additionalInstructions = 'a'.repeat(
      ASSISTANT_ADDITIONAL_INSTRUCTIONS_MAX_LENGTH + 1
    )
    expect(assistantConfigSchema.safeParse(globalOver).success).toBe(false)

    for (const channel of ['widget', 'email'] as const) {
      const channelOver = validConfig()
      channelOver.channels[channel] = {
        additionalInstructions: 'a'.repeat(ASSISTANT_CHANNEL_INSTRUCTIONS_MAX_LENGTH + 1),
      }
      expect(assistantConfigSchema.safeParse(channelOver).success).toBe(false)
    }
  })

  it('accepts every tone, response length, and tool-control value', () => {
    for (const tone of ASSISTANT_TONES) {
      const config = validConfig()
      config.voice.tone = tone
      expect(assistantConfigSchema.safeParse(config).success).toBe(true)
    }

    for (const responseLength of ASSISTANT_RESPONSE_LENGTHS) {
      const config = validConfig()
      config.voice.responseLength = responseLength
      expect(assistantConfigSchema.safeParse(config).success).toBe(true)
    }

    for (const control of ASSISTANT_TOOL_CONTROLS) {
      const config = validConfig()
      config.toolControls.search_knowledge = control
      expect(assistantConfigSchema.safeParse(config).success).toBe(true)
    }
  })

  it('rejects unknown versions, presets, and tool-control values', () => {
    expect(assistantConfigSchema.safeParse({ ...validConfig(), version: 1 }).success).toBe(false)
    expect(
      assistantConfigSchema.safeParse({
        ...validConfig(),
        voice: { ...validConfig().voice, tone: 'casual' },
      }).success
    ).toBe(false)
    expect(
      assistantConfigSchema.safeParse({
        ...validConfig(),
        voice: { ...validConfig().voice, responseLength: 'unlimited' },
      }).success
    ).toBe(false)
    expect(
      assistantConfigSchema.safeParse({
        ...validConfig(),
        toolControls: { search_knowledge: 'enabled' },
      }).success
    ).toBe(false)
  })
})

describe('avatar URL policy', () => {
  it('accepts null and trimmed HTTP(S) URLs', () => {
    for (const avatarUrl of [
      null,
      ' http://example.com/avatar.png ',
      'https://cdn.example.com/avatar.webp?size=80',
      'HTTPS://EXAMPLE.COM/avatar.png',
    ]) {
      const config = validConfig()
      config.identity.avatarUrl = avatarUrl
      const result = assistantConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
      if (result.success && avatarUrl !== null) {
        expect(result.data.identity.avatarUrl).toBe(avatarUrl.trim())
      }
    }
  })

  it('rejects non-HTTP, relative, malformed, empty, and internally controlled URLs', () => {
    for (const avatarUrl of [
      '',
      '/avatar.png',
      'ftp://example.com/avatar.png',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      'mailto:support@example.com',
      'https://',
      'https://exa\nmple.com/avatar.png',
    ]) {
      const config = validConfig()
      config.identity.avatarUrl = avatarUrl
      expect(assistantConfigSchema.safeParse(config).success, avatarUrl).toBe(false)
    }
  })

  it('enforces the 2,000-character URL boundary', () => {
    const prefix = 'https://example.com/'
    const atLimit = `${prefix}${'a'.repeat(ASSISTANT_AVATAR_URL_MAX_LENGTH - prefix.length)}`
    const maximum = validConfig()
    maximum.identity.avatarUrl = atLimit
    expect(atLimit).toHaveLength(ASSISTANT_AVATAR_URL_MAX_LENGTH)
    expect(assistantConfigSchema.safeParse(maximum).success).toBe(true)

    const overLimit = validConfig()
    overLimit.identity.avatarUrl = `${atLimit}a`
    expect(assistantConfigSchema.safeParse(overLimit).success).toBe(false)
  })
})

describe('assistant configuration normalization', () => {
  it('removes every ASCII control except tab and newline, then trims external whitespace', () => {
    const removedControls = [
      ...Array.from({ length: 9 }, (_, code) => String.fromCharCode(code)),
      String.fromCharCode(11),
      String.fromCharCode(12),
      ...Array.from({ length: 19 }, (_, index) => String.fromCharCode(index + 13)),
      String.fromCharCode(127),
    ].join('')

    expect(normalizeAssistantText(` \t\nAlpha${removedControls}\tBeta\n `)).toBe(`Alpha\tBeta`)
  })

  it('normalizes names and instructions while preserving internal newlines, Unicode, and RTL text', () => {
    const input = validConfig()
    input.identity.name = ' \u0000Quinn وكيل\u007f '
    input.voice.additionalInstructions =
      ' \u0001Use café ☕.\r\nاكتب بالعربية.\nכתוב בעברית.\u001f '
    input.channels.widget = {
      additionalInstructions: ' \u000bFirst line\n\t第二行\u007f ',
    }

    expect(normalizeAssistantConfig(input)).toMatchObject({
      identity: { name: 'Quinn وكيل' },
      voice: {
        additionalInstructions: 'Use café ☕.\nاكتب بالعربية.\nכתוב בעברית.',
      },
      channels: {
        widget: { additionalInstructions: 'First line\n\t第二行' },
      },
    })
  })

  it('removes empty channel overrides but keeps the required global empty string', () => {
    const input = validConfig()
    input.voice.additionalInstructions = ' \n\t\u0000 '
    input.channels = {
      widget: { additionalInstructions: ' \n\t\u007f ' },
      email: { additionalInstructions: ' \u0001 Email only \u001f ' },
    }

    expect(normalizeAssistantConfig(input)).toMatchObject({
      voice: { additionalInstructions: '' },
      channels: { email: { additionalInstructions: 'Email only' } },
    })
    expect(normalizeAssistantConfig(input).channels).not.toHaveProperty('widget')
  })

  it('is pure and also trims an avatar URL', () => {
    const input = validConfig()
    input.identity.avatarUrl = ' https://example.com/avatar.png '
    input.voice.additionalInstructions = '  Keep this concise.  '
    const before = structuredClone(input)

    const normalized = normalizeAssistantConfig(input)

    expect(input).toEqual(before)
    expect(normalized).not.toBe(input)
    expect(normalized.identity.avatarUrl).toBe('https://example.com/avatar.png')
    expect(normalized.voice.additionalInstructions).toBe('Keep this concise.')
  })

  it('rejects normalized values over every limit rather than truncating them', () => {
    const cases: Array<[string, (config: AssistantConfig) => void]> = [
      [
        'name',
        (config) => {
          config.identity.name = 'n'.repeat(ASSISTANT_NAME_MAX_LENGTH + 1)
        },
      ],
      [
        'avatar URL',
        (config) => {
          const prefix = 'https://example.com/'
          config.identity.avatarUrl = `${prefix}${'a'.repeat(
            ASSISTANT_AVATAR_URL_MAX_LENGTH + 1 - prefix.length
          )}`
        },
      ],
      [
        'global instructions',
        (config) => {
          config.voice.additionalInstructions = 'g'.repeat(
            ASSISTANT_ADDITIONAL_INSTRUCTIONS_MAX_LENGTH + 1
          )
        },
      ],
      [
        'widget instructions',
        (config) => {
          config.channels.widget = {
            additionalInstructions: 'w'.repeat(ASSISTANT_CHANNEL_INSTRUCTIONS_MAX_LENGTH + 1),
          }
        },
      ],
      [
        'email instructions',
        (config) => {
          config.channels.email = {
            additionalInstructions: 'e'.repeat(ASSISTANT_CHANNEL_INSTRUCTIONS_MAX_LENGTH + 1),
          }
        },
      ],
    ]

    for (const [label, change] of cases) {
      const config = validConfig()
      change(config)
      expect(() => normalizeAssistantConfig(config), label).toThrow()
    }
  })
})

describe('voice preset catalogues', () => {
  it('exhaustively catalogues every preset with stable copy IDs and directives', () => {
    expect(Object.keys(ASSISTANT_TONE_CATALOGUE)).toEqual([...ASSISTANT_TONES])
    expect(Object.keys(ASSISTANT_RESPONSE_LENGTH_CATALOGUE)).toEqual([
      ...ASSISTANT_RESPONSE_LENGTHS,
    ])

    const messageIds = new Set<string>()
    for (const tone of ASSISTANT_TONES) {
      const preset = ASSISTANT_TONE_CATALOGUE[tone]
      expect(preset.id).toBe(tone)
      expect(preset.directive).toBe(ASSISTANT_TONE_DIRECTIVES[tone])
      messageIds.add(preset.labelMessageId)
      messageIds.add(preset.descriptionMessageId)
    }
    for (const responseLength of ASSISTANT_RESPONSE_LENGTHS) {
      const preset = ASSISTANT_RESPONSE_LENGTH_CATALOGUE[responseLength]
      expect(preset.id).toBe(responseLength)
      expect(preset.directive).toBe(ASSISTANT_RESPONSE_LENGTH_DIRECTIVES[responseLength])
      messageIds.add(preset.labelMessageId)
      messageIds.add(preset.descriptionMessageId)
    }

    expect(messageIds.size).toBe((ASSISTANT_TONES.length + ASSISTANT_RESPONSE_LENGTHS.length) * 2)
  })

  it('uses the normative prompt directives', () => {
    expect(ASSISTANT_TONE_DIRECTIVES).toEqual({
      warm: 'Use a warm, approachable tone. Be empathetic without over-apologizing or sounding overly enthusiastic.',
      balanced:
        'Use a clear, calm, natural tone. Be friendly without adding unnecessary enthusiasm or formality.',
      professional:
        'Use a polished, professional tone. Stay natural and direct; do not sound legalistic or impersonal.',
    })
    expect(ASSISTANT_RESPONSE_LENGTH_DIRECTIVES).toEqual({
      brief:
        'Prefer the shortest complete answer. Usually use one short paragraph or a compact list.',
      balanced:
        'Give enough context to make the answer clear, then state the next step. Avoid unnecessary detail.',
      detailed:
        'Give a fuller explanation and ordered steps when the request benefits from them. Do not add detail unrelated to the request.',
    })
  })
})

describe('assistant role catalogue', () => {
  it('is exhaustive and accepted by the role schema', () => {
    expect(Object.keys(ASSISTANT_ROLE_CATALOGUE)).toEqual([...ASSISTANT_ROLES])

    for (const role of ASSISTANT_ROLES) {
      expect(assistantRoleSchema.parse(role)).toBe(role)
      expect(ASSISTANT_ROLE_CATALOGUE[role].id).toBe(role)
    }
    expect(assistantRoleSchema.safeParse('other').success).toBe(false)
  })

  it('provides stable localized catalogue IDs for every role', () => {
    for (const role of ASSISTANT_ROLES) {
      expect(ASSISTANT_ROLE_CATALOGUE[role].labelMessageId).toContain('assistant.role.')
      expect(ASSISTANT_ROLE_CATALOGUE[role].descriptionMessageId).toContain('assistant.role.')
    }
  })
})
