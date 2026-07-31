/**
 * Searchable board multi-select used by integration config screens to scope
 * outbound events to specific boards.
 *
 * `null` means "all boards" — it maps to a null `filters` column on the event
 * mapping, which the dispatcher treats as unfiltered (see events/targets.ts).
 * Deselecting the last board collapses back to null rather than an empty array
 * so the two representations never diverge.
 */

import { useState, useMemo } from 'react'
import { ChevronUpDownIcon, CheckIcon } from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/shared/utils'

export interface BoardOption {
  id: string
  name: string
}

export function BoardFilterCombobox({
  boardIds,
  boards,
  onBoardIdsChange,
  disabled,
  ariaLabel = 'Board filter',
}: {
  boardIds: string[] | null
  boards: BoardOption[]
  onBoardIdsChange: (boardIds: string[] | null) => void
  disabled?: boolean
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const isAllBoards = !boardIds?.length
  const selectedSet = useMemo(() => new Set(boardIds ?? []), [boardIds])

  const triggerLabel = useMemo(() => {
    if (isAllBoards) return 'All boards'
    if (boardIds!.length === 1) {
      return boards.find((b) => b.id === boardIds![0])?.name ?? '1 board'
    }
    return `${boardIds!.length} boards`
  }, [isAllBoards, boardIds, boards])

  const toggleBoard = (id: string) => {
    if (selectedSet.has(id)) {
      const next = (boardIds ?? []).filter((b) => b !== id)
      onBoardIdsChange(next.length > 0 ? next : null)
    } else {
      onBoardIdsChange([...(boardIds ?? []), id])
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className={cn('truncate', isAllBoards && 'text-muted-foreground')}>
            {triggerLabel}
          </span>
          <ChevronUpDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
        {open && (
          <Command>
            <CommandInput placeholder="Search boards..." />
            <CommandList>
              <CommandEmpty>No boards found.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value="__all_boards__"
                  onSelect={() => {
                    onBoardIdsChange(null)
                    setOpen(false)
                  }}
                >
                  <CheckIcon
                    className={cn('mr-2 h-4 w-4', isAllBoards ? 'opacity-100' : 'opacity-0')}
                  />
                  All boards
                </CommandItem>
              </CommandGroup>
              {boards.length > 0 && <CommandSeparator />}
              <CommandGroup>
                {boards.map((board) => (
                  <CommandItem
                    key={board.id}
                    value={board.name}
                    onSelect={() => toggleBoard(board.id)}
                  >
                    <CheckIcon
                      className={cn(
                        'mr-2 h-4 w-4',
                        selectedSet.has(board.id) ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <span className="truncate">{board.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
}
