import { useState } from 'react'
import {
  BuildingOffice2Icon,
  PlusIcon,
  ChevronRightIcon,
  ArrowDownTrayIcon,
  BanknotesIcon,
  TagIcon,
} from '@heroicons/react/24/solid'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { cn } from '@/lib/shared/utils'
import { EmptyState } from '@/components/shared/empty-state'
import { SearchInput } from '@/components/shared/search-input'
import { FilterChip } from '@/components/shared/filter-chip'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useDebouncedSearch } from '@/lib/client/hooks/use-debounced-search'
import { buildCompaniesExportUrl } from '@/lib/shared/company-filters'
import { createCompanyFn, type CompanyWithMemberCountDTO } from '@/lib/server/functions/companies'

/** Render mrrCents as a whole-dollar currency amount, or a dash when unset. */
export function formatMonthlySpend(mrrCents: number | null): string {
  if (mrrCents == null) return '-'
  return (mrrCents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

const MRR_OPERATORS = [
  { value: 'gte', label: 'at least' },
  { value: 'gt', label: 'more than' },
  { value: 'lte', label: 'at most' },
  { value: 'lt', label: 'less than' },
  { value: 'eq', label: 'exactly' },
]

const OP_LABELS: Record<string, string> = {
  eq: 'equals',
  neq: 'not equals',
  contains: 'contains',
  is_set: 'is set',
  is_not_set: 'is not set',
  gt: 'more than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
}

/** Split the encoded companyAttrs param into its parts. */
function splitParts(encoded?: string): string[] {
  return (encoded ?? '').split(',').filter(Boolean)
}

function AddCompanyFilterButton({
  companyAttrs,
  onChange,
}: {
  companyAttrs?: string
  onChange: (encoded: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState<'plan' | 'mrr' | null>(null)
  const [planValue, setPlanValue] = useState('')
  const [mrrOp, setMrrOp] = useState('gte')
  const [mrrValue, setMrrValue] = useState('')

  const parts = splitParts(companyAttrs)
  const hasPlan = parts.some((p) => p.startsWith('plan:'))
  const hasMrr = parts.some((p) => p.startsWith('mrr:'))

  const close = () => {
    setOpen(false)
    setCategory(null)
    setPlanValue('')
    setMrrValue('')
  }

  const apply = (encoded: string) => {
    onChange([...parts, encoded].join(','))
    close()
  }

  if (hasPlan && hasMrr) return null

  return (
    <Popover
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen)
        if (!isOpen) setCategory(null)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs',
            'border border-dashed border-border/50 text-muted-foreground',
            'hover:text-foreground hover:border-border hover:bg-muted/30 transition-colors'
          )}
        >
          <PlusIcon className="h-3 w-3" />
          Add filter
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-0">
        {category === null ? (
          <div className="py-1">
            {!hasPlan && (
              <button
                type="button"
                onClick={() => setCategory('plan')}
                className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs text-left hover:bg-muted/50 transition-colors"
              >
                <span className="flex items-center gap-2">
                  <TagIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  Plan
                </span>
                <ChevronRightIcon className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
            {!hasMrr && (
              <button
                type="button"
                onClick={() => setCategory('mrr')}
                className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs text-left hover:bg-muted/50 transition-colors"
              >
                <span className="flex items-center gap-2">
                  <BanknotesIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  Monthly spend
                </span>
                <ChevronRightIcon className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
          </div>
        ) : category === 'plan' ? (
          <div className="p-2 space-y-2">
            <Input
              className="h-7 text-xs"
              placeholder="Scale"
              value={planValue}
              autoFocus
              onChange={(e) => setPlanValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && planValue.trim()) apply(`plan:eq:${planValue.trim()}`)
              }}
            />
            <Button
              size="sm"
              className="w-full h-7 text-xs"
              disabled={!planValue.trim()}
              onClick={() => apply(`plan:eq:${planValue.trim()}`)}
            >
              Apply
            </Button>
          </div>
        ) : (
          <div className="p-2 space-y-2">
            <Select value={mrrOp} onValueChange={setMrrOp}>
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MRR_OPERATORS.map((o) => (
                  <SelectItem key={o.value} value={o.value} className="text-xs">
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="number"
              className="h-7 text-xs"
              placeholder="0"
              value={mrrValue}
              onChange={(e) => setMrrValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && mrrValue) apply(`mrr:${mrrOp}:${mrrValue}`)
              }}
            />
            <Button
              size="sm"
              className="w-full h-7 text-xs"
              disabled={!mrrValue}
              onClick={() => apply(`mrr:${mrrOp}:${mrrValue}`)}
            >
              Apply
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function CompanyFiltersBar({
  companyAttrs,
  onChange,
}: {
  companyAttrs?: string
  onChange: (encoded: string | undefined) => void
}) {
  const parts = splitParts(companyAttrs)

  const removePart = (part: string) => {
    const remaining = parts.filter((p) => p !== part)
    onChange(remaining.length > 0 ? remaining.join(',') : undefined)
  }

  return (
    <div className="flex flex-wrap gap-1 items-center">
      {parts.map((part) => {
        const [key, op, ...rest] = part.split(':')
        if (!key || !op) return null
        const value = rest.join(':')
        const opLabel = OP_LABELS[op] ?? op
        const label = key === 'mrr' ? 'Spend:' : key === 'plan' ? 'Plan:' : `${key}:`
        const display =
          op === 'is_set' || op === 'is_not_set'
            ? opLabel
            : key === 'plan' && op === 'eq'
              ? value
              : `${opLabel} ${value}`
        return (
          <FilterChip
            key={part}
            icon={key === 'mrr' ? BanknotesIcon : TagIcon}
            label={label}
            value={display}
            valueId={part}
            onRemove={() => removePart(part)}
          />
        )
      })}
      <AddCompanyFilterButton companyAttrs={companyAttrs} onChange={onChange} />
      {parts.length > 1 && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted/50 transition-colors"
        >
          Clear all
        </button>
      )}
    </div>
  )
}

function NewCompanyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [domain, setDomain] = useState('')

  const create = useMutation({
    mutationFn: () =>
      createCompanyFn({ data: { name: name.trim(), domain: domain.trim() || null } }),
    onSuccess: async (company) => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'companies'] })
      onOpenChange(false)
      setName('')
      setDomain('')
      onCreated(company.id)
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to create company')
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) create.mutate()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="company-name">Name</Label>
            <Input
              id="company-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="company-domain">
              Email domain <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              id="company-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="acme.com"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? 'Creating...' : 'Create company'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface CompaniesViewProps {
  companies: CompanyWithMemberCountDTO[] | undefined
  isLoading: boolean
  search?: string
  onSearchChange: (value: string | undefined) => void
  companyAttrs?: string
  onCompanyAttrsChange: (encoded: string | undefined) => void
  onSelectCompany: (id: string) => void
  canManage: boolean
}

export function CompaniesView({
  companies,
  isLoading,
  search,
  onSearchChange,
  companyAttrs,
  onCompanyAttrsChange,
  onSelectCompany,
  canManage,
}: CompaniesViewProps) {
  const [createOpen, setCreateOpen] = useState(false)
  const { value: searchValue, setValue: setSearchValue } = useDebouncedSearch({
    externalValue: search,
    onChange: (value) => onSearchChange(value),
  })

  const total = companies?.length ?? 0
  const hasActiveFilters = !!(search || companyAttrs)

  return (
    <div className="max-w-5xl mx-auto w-full">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm px-3 py-2.5">
        <div className="flex items-center gap-2">
          <SearchInput
            value={searchValue}
            onChange={setSearchValue}
            placeholder="Search companies..."
            data-search-input
          />
          <div className="flex-1" />
          <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" asChild>
            <a href={buildCompaniesExportUrl(search, companyAttrs)} download>
              <ArrowDownTrayIcon className="h-3.5 w-3.5" />
              Export CSV
            </a>
          </Button>
          {canManage && (
            <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => setCreateOpen(true)}>
              <PlusIcon className="h-3.5 w-3.5" />
              New company
            </Button>
          )}
        </div>

        <div className="mt-2">
          <CompanyFiltersBar companyAttrs={companyAttrs} onChange={onCompanyAttrsChange} />
        </div>

        <div className="mt-2 text-xs text-muted-foreground">
          {total} {total === 1 ? 'company' : 'companies'}
        </div>
      </div>

      <div className="p-3">
        {isLoading ? (
          <div className="rounded-xl overflow-hidden shadow-sm divide-y divide-border/50 bg-card border border-border/50">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-3">
                <Skeleton className="h-9 w-9 rounded-lg shrink-0" />
                <div className="flex-1">
                  <Skeleton className="h-4 w-40 mb-1.5" />
                  <Skeleton className="h-3 w-28" />
                </div>
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </div>
        ) : !companies || companies.length === 0 ? (
          <div className="rounded-xl overflow-hidden shadow-sm bg-card border border-border/50">
            <EmptyState
              icon={BuildingOffice2Icon}
              title={hasActiveFilters ? 'No companies match your filters' : 'No companies yet'}
              description={
                hasActiveFilters
                  ? "Try adjusting your filters to find what you're looking for."
                  : 'Companies appear here when people are linked to one, via the API or an agent.'
              }
              action={
                hasActiveFilters ? (
                  <button
                    type="button"
                    onClick={() => {
                      onSearchChange(undefined)
                      onCompanyAttrsChange(undefined)
                    }}
                    className="text-sm text-primary hover:underline"
                  >
                    Clear filters
                  </button>
                ) : undefined
              }
              className="py-12"
            />
          </div>
        ) : (
          <div className="rounded-xl overflow-hidden shadow-sm divide-y divide-border/50 bg-card border border-border/50">
            {/* Column header */}
            <div className="hidden sm:flex items-center gap-3 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-muted/30">
              <span className="flex-1 min-w-0">Company</span>
              <span className="w-24 text-left">Plan</span>
              <span className="w-24 text-right">Monthly spend</span>
              <span className="w-16 text-right">People</span>
            </div>
            {companies.map((company) => (
              <button
                key={company.id}
                type="button"
                onClick={() => onSelectCompany(company.id)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <BuildingOffice2Icon className="h-4.5 w-4.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{company.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {company.domain ?? 'No domain'}
                  </div>
                </div>
                <span className="w-24 shrink-0 hidden sm:block">
                  {company.plan ? (
                    <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                      {company.plan}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground/60">-</span>
                  )}
                </span>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-foreground hidden sm:block">
                  {formatMonthlySpend(company.mrrCents)}
                </span>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {company.memberCount}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <NewCompanyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={onSelectCompany}
      />
    </div>
  )
}
