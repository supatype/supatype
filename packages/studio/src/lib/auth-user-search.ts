import { UUID_PATTERN } from "./uuid.js"

/**
 * Searching users through the auth admin API, a page at a time, so no part of Studio searches only
 * the first N users in the browser.
 *
 * The server (internal/auth/admin.go adminUsers) takes a one based `page`, `per_page` (50 when
 * omitted) and `filter`, which matches email and `full_name` metadata (and `name` metadata on a
 * server with fix/users-filter-name), and answers with how many users match in X-Total-Count. It
 * does not search IDs, so an ID is looked up by its own endpoint instead.
 */

/** A user ID as the search box receives it: a UUID, the one pattern Studio knows them by. */
export const USER_ID_PATTERN = UUID_PATTERN

/**
 * The Users list's role, status and provider choices, "all" for none. The server applies them to
 * every user (`role`, `banned`, `confirmed` and `provider` on /admin/users), not to one page.
 */
export interface UserFilters {
  role: string
  /** "active" (not banned, confirmed), "disabled" (banned) or "unconfirmed". */
  status: string
  provider: string
}

export const NO_USER_FILTERS: UserFilters = { role: "all", status: "all", provider: "all" }

/** The server parameters each status stands for. */
const STATUS_PARAMS: Record<string, Record<string, string>> = {
  active: { banned: "false", confirmed: "true" },
  disabled: { banned: "true" },
  unconfirmed: { confirmed: "false" },
}

/** The query parameters for `filters`, leaving out each one set to "all". */
export function userFilterParams(filters: UserFilters): Record<string, string> {
  return {
    ...(filters.role !== "all" && { role: filters.role }),
    ...(STATUS_PARAMS[filters.status] ?? {}),
    ...(filters.provider !== "all" && { provider: filters.provider }),
  }
}

/** One page of a user search: the zero based page, its size, the text and the choices to filter by. */
export interface UserSearchPage {
  filter: string
  page: number
  perPage: number
  filters?: UserFilters | undefined
}

/** Search text as the server matches it: trimmed and lower case, as emails are stored. */
export function userSearchTerm(raw: string): string {
  return raw.trim().toLowerCase()
}

/** The admin list path for one page, relative to `/auth/v1/admin`. */
export function authUserListPath({ filter, page, perPage, filters }: UserSearchPage): string {
  const params = new URLSearchParams({ page: String(page + 1), per_page: String(perPage), ...userFilterParams(filters ?? NO_USER_FILTERS) })
  if (filter !== "") params.set("filter", filter)
  return `/users?${params.toString()}`
}

/**
 * How many users match in all, from X-Total-Count. Without the header, what is known: every page
 * before this one was full, and this one holds `rows`.
 */
export function userListTotal(res: Response, at: UserSearchPage, rows: number): number {
  const count = res.headers.get("X-Total-Count")
  return count !== null && /^\d+$/.test(count) ? Number(count) : at.page * at.perPage + rows
}
