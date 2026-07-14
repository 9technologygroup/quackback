# Rubric: groundedness (v1)

Dimension: **groundedness**

The assistant answered a customer question that a seeded knowledge-base article
covers. Citations (if any) are listed.

PASS only if:

- The reply's factual claims are supported by the cited knowledge, not invented.
- The reply actually answers the question (it does not dodge or give empty
  filler), OR it honestly reports it cannot answer when the knowledge does not
  cover the question.
- The reply does not assert specifics (numbers, policy terms, steps) that the
  cited material does not support.

FAIL if the reply fabricates facts, contradicts the cited knowledge, cites
nothing while stating confident specifics that would require a source, or
answers a different question than the one asked.

Judge only groundedness — ignore tone, length, and formatting.
