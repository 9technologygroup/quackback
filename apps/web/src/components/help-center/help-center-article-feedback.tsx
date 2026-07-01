import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { FormattedMessage } from 'react-intl'
import { recordArticleFeedbackFn } from '@/lib/server/functions/help-center'
import type { KbArticleId } from '@quackback/ids'

interface HelpCenterArticleFeedbackProps {
  articleId: string
  /** When set, a "not helpful" vote offers a contact-support pathway here. */
  supportHref?: string | null
}

export function HelpCenterArticleFeedback({
  articleId,
  supportHref,
}: HelpCenterArticleFeedbackProps) {
  const [feedback, setFeedback] = useState<'helpful' | 'not-helpful' | null>(null)
  const [isPending, setIsPending] = useState(false)

  const handleFeedback = async (helpful: boolean) => {
    if (isPending) return
    const newFeedback = helpful ? 'helpful' : 'not-helpful'
    if (feedback === newFeedback) return
    setIsPending(true)
    try {
      await recordArticleFeedbackFn({
        data: { articleId: articleId as KbArticleId, helpful },
      })
      setFeedback(newFeedback)
    } catch {
      // non-critical
    } finally {
      setIsPending(false)
    }
  }

  const subtitle =
    feedback === null
      ? 'Your feedback shapes what we write next.'
      : feedback === 'helpful'
        ? 'Thanks — glad it landed.'
        : "Noted. We'll revisit this article."

  return (
    <div className="mt-10 rounded-xl border border-border/50 bg-card px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
      <div>
        <p className="text-sm font-semibold text-foreground">Was this helpful?</p>
        <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => handleFeedback(true)}
          disabled={isPending}
          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-50 ${
            feedback === 'helpful'
              ? 'bg-primary/10 border border-primary/20 text-primary'
              : 'bg-muted/60 border border-border/60 text-foreground hover:bg-muted'
          }`}
        >
          👍 Yes
        </button>
        <button
          type="button"
          onClick={() => handleFeedback(false)}
          disabled={isPending}
          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-50 ${
            feedback === 'not-helpful'
              ? 'bg-primary/10 border border-primary/20 text-primary'
              : 'bg-muted/60 border border-border/60 text-foreground hover:bg-muted'
          }`}
        >
          👎 No
        </button>
      </div>
      {feedback === 'not-helpful' && supportHref && (
        <div className="w-full border-t border-border/50 pt-3 text-sm">
          <span className="text-muted-foreground">
            <FormattedMessage
              id="portal.hc.articleFeedback.stillStuck"
              defaultMessage="Still stuck?"
            />
          </span>{' '}
          <Link to={supportHref} className="font-medium text-primary hover:underline">
            <FormattedMessage
              id="portal.hc.articleFeedback.contactSupport"
              defaultMessage="Contact support"
            />
          </Link>
        </div>
      )}
    </div>
  )
}
