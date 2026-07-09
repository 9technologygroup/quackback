'use client'

import {
  LightBulbIcon,
  ChatBubbleLeftRightIcon,
  BookOpenIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline'
import {
  normalizeOnboardingOutcome,
  type UseCaseType,
  type OnboardingOutcome,
} from '@/lib/shared/db-types'
import { Badge } from '@/components/ui/badge'
import type { ComponentType } from 'react'

interface OutcomeOption {
  id: OnboardingOutcome
  label: string
  description: string
  /** Who this is for — ICP cue, not jargon */
  forWhom: string
  icon: ComponentType<{ className?: string }>
}

/**
 * Outcome-first picker, modeled on how Intercom / Featurebase / Statuspage
 * ICPs actually buy:
 *
 *  - Product feedback  → Featurebase / Canny PM & founder ICP
 *  - Customer support  → Intercom support / CX ICP
 *  - Help center       → Self-serve / deflect volume
 *  - Internal          → Employee voice / ops feedback
 *
 * Stored as setupState.useCase. Legacy saas|consumer|marketplace map in
 * display via normalizeOnboardingOutcome.
 */
const OUTCOME_OPTIONS: OutcomeOption[] = [
  {
    id: 'product_feedback',
    label: 'Collect product feedback',
    description: 'Feature ideas, votes, a public roadmap, and changelogs',
    forWhom: 'Product & eng',
    icon: LightBulbIcon,
  },
  {
    id: 'customer_support',
    label: 'Talk to customers',
    description: 'Live chat and a shared inbox your team works from',
    forWhom: 'Support & CX',
    icon: ChatBubbleLeftRightIcon,
  },
  {
    id: 'help_center',
    label: 'Help people help themselves',
    description: 'A searchable knowledge base that deflects repetitive questions',
    forWhom: 'Support & docs',
    icon: BookOpenIcon,
  },
  {
    id: 'internal',
    label: 'Hear from our own team',
    description: 'Ideas and process improvements from colleagues',
    forWhom: 'Internal',
    icon: UserGroupIcon,
  },
]

interface UseCaseSelectorProps {
  value: UseCaseType | undefined
  onChange: (value: UseCaseType) => void
  disabled?: boolean
}

export function UseCaseSelector({ value, onChange, disabled }: UseCaseSelectorProps) {
  const displayValue = normalizeOnboardingOutcome(value)

  return (
    <div className="space-y-2 max-w-md mx-auto">
      {OUTCOME_OPTIONS.map((option) => {
        const isSelected = displayValue === option.id
        const Icon = option.icon
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            disabled={disabled}
            className={`
              w-full flex items-center gap-4 p-4
              rounded-xl border transition-all duration-200
              disabled:cursor-not-allowed disabled:opacity-50
              ${
                isSelected
                  ? 'border-primary bg-primary/5 shadow-sm'
                  : 'border-border/50 bg-card/50 hover:border-border hover:bg-card/80'
              }
            `}
          >
            <div
              className={`
              shrink-0 p-2.5 rounded-lg transition-colors
              ${isSelected ? 'bg-primary/10' : 'bg-muted/50'}
            `}
            >
              <Icon
                className={`h-5 w-5 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`}
              />
            </div>

            <div className="text-left min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <div
                  className={`font-medium text-sm ${isSelected ? 'text-foreground' : 'text-foreground/90'}`}
                >
                  {option.label}
                </div>
                <Badge size="sm" shape="pill" variant="secondary">
                  {option.forWhom}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">{option.description}</div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
