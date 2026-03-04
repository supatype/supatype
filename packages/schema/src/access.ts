import type { AccessRuleDef } from "./types.js"

/** Anyone can perform this action, including anonymous users. */
export const publicAccess = (): AccessRuleDef => ({ type: "public" })

/** Only the platform's service role can perform this action. */
export const privateAccess = (): AccessRuleDef => ({ type: "private" })

/**
 * Only the row owner can perform this action.
 * @param field - The column on this table that holds the owner's user ID.
 */
export const owner = (field: string): AccessRuleDef => ({ type: "owner", field })

/**
 * Only users with one of the given roles can perform this action.
 */
export const role = (...roles: string[]): AccessRuleDef => ({ type: "role", roles })

/**
 * Custom SQL expression for advanced cases.
 * Use `auth.uid()`, `auth.role()`, `auth.roles()` within the expression.
 */
export const custom = (expression: string): AccessRuleDef => ({ type: "custom", expression })

export const access = {
  public: publicAccess,
  private: privateAccess,
  owner,
  role,
  custom,
} as const
