/**
 * Live integration smoke test against a local Ollama (skipped when unreachable).
 *
 *   OPENAI_BASE_URL=http://localhost:11434/v1  OPENAI_API_KEY=ollama
 *   AI_CHAT_MODEL=gemma4:12b-it-q4_K_M
 *
 * Exercises the real runtime end to end: real TanStack AI chat() against Ollama,
 * real structured-output decoding (terse models can return an empty object,
 * which the runtime treats as retryable), and the retrieval keyword fallback
 * (no local embedding model, so the semantic path is skipped by design).
 */
import { describe, it, expect, vi } from 'vitest'

const OLLAMA_BASE = process.env.OPENAI_BASE_URL || 'http://localhost:11434/v1'
const OLLAMA_MODEL = process.env.AI_CHAT_MODEL || 'gemma4:12b-it-q4_K_M'

// Point the runtime + retrieval at Ollama and the test DB. Embeddings stay off
// so retrieval runs its keyword fallback (the pgvector dims differ locally).
vi.mock('@/lib/server/config', () => ({
  config: {
    databaseUrl: process.env.DATABASE_URL,
    openaiApiKey: process.env.OPENAI_API_KEY || 'ollama',
    openaiBaseUrl: OLLAMA_BASE,
    aiChatModel: OLLAMA_MODEL,
    aiEmbeddingModel: undefined,
    aiSummaryModel: undefined,
    aiSentimentModel: undefined,
    aiExtractionModel: undefined,
    aiQualityGateModel: undefined,
    aiInterpretationModel: undefined,
    aiMergeModel: undefined,
    aiHelpCenterModel: undefined,
  },
}))

async function ollamaReachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 2000)
    const res = await fetch(`${OLLAMA_BASE}/models`, { signal: ctrl.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

const reachable = await ollamaReachable()

describe.skipIf(!reachable)('assistant runtime (live Ollama)', () => {
  it('produces a structured, cited answer through the real loop', async () => {
    const { runAssistantTurn } = await import('../assistant.runtime')

    const result = await runAssistantTurn({
      assistantPrincipalId: 'principal_assistant' as never,
      messages: [{ sender: 'customer', content: 'What is your refund policy?' }],
    })

    expect(result.status).toBe('answered')
    if (result.status === 'answered') {
      expect(typeof result.text).toBe('string')
      expect(result.text.length).toBeGreaterThan(0)
      // Citations are a structured contract: an array of ledger-backed sources
      // (empty here, since the test KB has no matching article).
      expect(Array.isArray(result.citations)).toBe(true)
    }
  }, 60_000)
})
