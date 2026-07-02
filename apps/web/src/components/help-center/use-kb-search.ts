/**
 * Debounced help-center article search against /api/widget/kb-search, with a
 * small per-mount result cache and in-flight abort. Shared by the widget
 * Help tab and the /hc hero search.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface KbSearchArticle {
  id: string
  slug: string
  title: string
  content: string
  category: { id: string; slug: string; name: string }
}

const DEBOUNCE_MS = 300
const CACHE_SIZE = 30

export function useKbSearch({
  query,
  limit,
  onResults,
}: {
  query: string
  limit: number
  /** Fired with the articles of each completed search (cache hits included);
   *  not fired when the query is blank. */
  onResults?: (articles: KbSearchArticle[]) => void
}): { results: KbSearchArticle[]; isSearching: boolean } {
  const [results, setResults] = useState<KbSearchArticle[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const cacheRef = useRef(new Map<string, KbSearchArticle[]>())
  // Latest callback without retriggering the debounce effect.
  const onResultsRef = useRef(onResults)
  onResultsRef.current = onResults

  const doSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setResults([])
        return
      }

      const cached = cacheRef.current.get(q)
      if (cached) {
        setResults(cached)
        onResultsRef.current?.(cached)
        return
      }

      if (cacheRef.current.size >= CACHE_SIZE) {
        const firstKey = cacheRef.current.keys().next().value!
        cacheRef.current.delete(firstKey)
      }

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsSearching(true)
      try {
        const res = await fetch(`/api/widget/kb-search?q=${encodeURIComponent(q)}&limit=${limit}`, {
          signal: controller.signal,
        })
        const data = await res.json()
        const articles: KbSearchArticle[] = data.data?.articles ?? []
        cacheRef.current.set(q, articles)
        setResults(articles)
        onResultsRef.current?.(articles)
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
      } finally {
        setIsSearching(false)
      }
    },
    [limit]
  )

  useEffect(() => {
    const timer = setTimeout(() => void doSearch(query), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, doSearch])

  return { results, isSearching }
}
