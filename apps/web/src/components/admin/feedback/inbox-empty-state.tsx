import { Link, useRouteContext } from '@tanstack/react-router'
import {
  MagnifyingGlassIcon,
  DocumentIcon,
  SparklesIcon,
  CodeBracketIcon,
  GlobeAltIcon,
} from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/shared/empty-state'

interface InboxEmptyStateProps {
  type: 'no-posts' | 'no-results' | 'no-selection'
  onClearFilters?: () => void
}

export function InboxEmptyState({ type, onClearFilters }: InboxEmptyStateProps) {
  const { userRole } = useRouteContext({ from: '__root__' })
  // Widget setup and the launch checklist live behind admin-only settings;
  // members get the share path only.
  const isAdmin = userRole === 'admin'

  if (type === 'no-results') {
    return (
      <EmptyState
        icon={MagnifyingGlassIcon}
        title="No results for these filters"
        description="Try adjusting your search or filter criteria."
        action={
          onClearFilters && (
            <Button variant="outline" onClick={onClearFilters}>
              Clear all filters
            </Button>
          )
        }
      />
    )
  }

  if (type === 'no-posts') {
    return (
      <EmptyState
        icon={SparklesIcon}
        title="No feedback yet"
        description="Hear from customers on your site or share a public board."
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {isAdmin && (
              <Button size="sm" asChild>
                <Link to="/admin/settings/widget">
                  <CodeBracketIcon className="h-3.5 w-3.5" />
                  Add to your site
                </Link>
              </Button>
            )}
            <Button size="sm" variant={isAdmin ? 'outline' : 'default'} asChild>
              <Link to="/">
                <GlobeAltIcon className="h-3.5 w-3.5" />
                Share board
              </Link>
            </Button>
            {isAdmin && (
              <Button size="sm" variant="ghost" asChild>
                <Link to="/admin/getting-started">Launch checklist</Link>
              </Button>
            )}
          </div>
        }
      />
    )
  }

  // no-selection
  return (
    <EmptyState
      icon={DocumentIcon}
      title="Select a post"
      description="Choose a post from the list to view its details."
      className="h-full"
    />
  )
}
