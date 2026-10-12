import { useIntl } from 'react-intl'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/shared/utils'
import { approvalMessages } from './approval-messages'

export type ApprovalRisk = 'low' | 'medium' | 'high' | 'critical'

const RISK = {
  low: { variant: 'secondary', className: '', label: approvalMessages.riskLow },
  medium: { variant: 'warning', className: '', label: approvalMessages.riskMedium },
  high: {
    variant: 'default',
    className: 'bg-[#c2410c] text-white [a&]:hover:bg-[#c2410c]',
    label: approvalMessages.riskHigh,
  },
  critical: {
    variant: 'default',
    className: 'bg-[#991b1b] text-white [a&]:hover:bg-[#991b1b]',
    label: approvalMessages.riskCritical,
  },
} as const

/** A request's risk as a chip: Low, Medium, High or Critical. */
export function ApprovalRiskChip({ risk, className }: { risk: ApprovalRisk; className?: string }) {
  const intl = useIntl()
  const tone = RISK[risk] ?? RISK.medium
  return (
    <Badge
      size="sm"
      variant={tone.variant}
      data-risk={risk}
      className={cn('rounded-full', tone.className, className)}
    >
      {intl.formatMessage(tone.label)}
    </Badge>
  )
}
