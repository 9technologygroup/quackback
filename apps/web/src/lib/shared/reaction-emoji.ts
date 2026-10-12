/**
 * What a comment reaction may be: one emoji, never free text. The portal and
 * widget offer a fixed set (REACTION_EMOJIS), while the API and MCP accept any
 * single emoji, so the check is on shape rather than membership.
 *
 * The shape is built only from the parts emoji are made of, so nothing can
 * ride along unseen: no tag characters spelling hidden text, no supplementary
 * variation selectors, no combining marks or format characters.
 */

const MAX_LENGTH = 32

// One pictograph with an optional skin tone and presentation selector.
const ELEMENT = String.raw`\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?[︎️]?`

/** Pictographs joined by zero-width joiners: 👍, 👍🏽, 👩‍💻, ❤️‍🔥. */
const SEQUENCE = new RegExp(`^${ELEMENT}(?:\\u200D${ELEMENT})*$`, 'u')
/** A country flag: two regional indicators. */
const FLAG = /^\p{Regional_Indicator}{2}$/u
/**
 * The three standard subdivision flags (England, Scotland, Wales): the black
 * flag, "gb" and a region in tag letters, then the cancel tag. Only these, so
 * tag letters can never carry other text.
 */
const SUBDIVISION_FLAG =
  /^\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}$/u
/** A keycap: digit, # or *, an optional presentation selector, the keycap mark. */
const KEYCAP = /^[0-9#*]️?⃣$/u

/** True when `value` is exactly one emoji. */
export function isReactionEmoji(value: string): boolean {
  if (value.length === 0 || value.length > MAX_LENGTH) return false
  return (
    SEQUENCE.test(value) || FLAG.test(value) || SUBDIVISION_FLAG.test(value) || KEYCAP.test(value)
  )
}

export const REACTION_EMOJI_MESSAGE = 'A reaction must be a single emoji'
