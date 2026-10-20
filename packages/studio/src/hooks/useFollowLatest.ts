import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react"

/**
 * A scroll area that follows its newest entry, the way a log tail does.
 *
 * It stays at the bottom while the reader is there, and stops the moment they scroll up to read
 * something, because yanking the page back down under someone mid-sentence is worse than not
 * following at all. Entries that arrive while it is not following are counted, so the control
 * that jumps back can say how many there are. Reaching the bottom again, by scrolling or by that
 * control, resumes following.
 */

/** How far from the bottom, in pixels, still counts as at the bottom: a wheel tick's rounding. */
const AT_BOTTOM_SLACK = 24

export interface FollowLatest {
  scrollerRef: RefObject<HTMLDivElement | null>
  following: boolean
  /** Entries that arrived while the reader was scrolled away. */
  unseen: number
  onScroll: () => void
  jumpToLatest: () => void
}

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK
}

/** How many of `keys` (newest first) are newer than `previous`; all of them when it is gone. */
function arrivalsSince(keys: readonly string[], previous: string | null): number {
  if (previous === null) return keys.length
  const at = keys.indexOf(previous)
  return at === -1 ? keys.length : at
}

/** Follows the entries named by `keys`, newest first, in the element given `scrollerRef`. */
export function useFollowLatest(keys: readonly string[]): FollowLatest {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const followingRef = useRef(true)
  const newestRef = useRef<string | null>(null)
  const [following, setFollowing] = useState(true)
  const [unseen, setUnseen] = useState(0)

  const follow = useCallback((on: boolean) => {
    followingRef.current = on
    setFollowing(on)
    if (on) setUnseen(0)
  }, [])

  useLayoutEffect(() => {
    const previous = newestRef.current
    newestRef.current = keys[0] ?? null
    const el = scrollerRef.current
    if (el === null) return
    if (followingRef.current) el.scrollTop = el.scrollHeight
    else if (newestRef.current !== previous) setUnseen((n) => n + arrivalsSince(keys, previous))
  }, [keys])

  const onScroll = useCallback(() => {
    const el = scrollerRef.current
    if (el !== null) follow(isAtBottom(el))
  }, [follow])

  const jumpToLatest = useCallback(() => {
    const el = scrollerRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
    follow(true)
  }, [follow])

  return { scrollerRef, following, unseen, onScroll, jumpToLatest }
}
