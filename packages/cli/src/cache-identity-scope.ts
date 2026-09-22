/**
 * Whether an access rule's outcome varies by *who* is asking.
 *
 * This decides whether a model may declare `cache: { public: true }`. A public cache entry is
 * global — one response served to every caller — so on a table whose read rule varies by caller it
 * serves one user's rows to another.
 *
 * **Row-dependence is not the same question, and getting that wrong in either direction is a bug.**
 * `Lte<"published_at", Now>` varies by row and by time but not by caller, so a shared entry is
 * exactly right for it: that is the case public caching exists to serve. Refusing it would make the
 * feature useless. Allowing `Owner<"user_id">` would make it a data leak.
 *
 * ## This is the second implementation of one rule
 *
 * supatype-server already answers this at runtime, in
 * `internal/studiobootstrap.IsIdentityDependent`, to decide whether a response may be cached under
 * a shared scope. This one answers it at *push* time, where the error can name the model and the
 * rule instead of a request quietly not being cached.
 *
 * Two implementations of one rule drift, and the drift is silent: the push says "shareable" and the
 * runtime says "not", or worse the other way round. `tests/fixtures/identity-scope-corpus.json` is
 * the defence — a shared corpus of rules and expected answers that both sides run against. Change
 * this file and you change that corpus; the Go side reads the same cases.
 */

/** A rule node, in the shape the extractor emits and the server parses. */
export interface AccessRuleNode {
  type?: string
  left?: AccessOperand
  right?: AccessOperand
  operand?: AccessOperand
  rules?: AccessRuleNode[]
  rule?: AccessRuleNode
}

export interface AccessOperand {
  kind?: string
}

/**
 * The operands whose value differs per caller. Columns, literals and the temporal operands
 * (`Now` and friends) are the same for everyone, so they are not here.
 */
const IDENTITY_OPERANDS = new Set(["authUid", "authRole", "claim"])

function operandIsIdentityDependent(o: AccessOperand | undefined): boolean {
  if (!o) return false
  return IDENTITY_OPERANDS.has(o.kind ?? "")
}

export function isIdentityDependent(rule: AccessRuleNode | undefined | null): boolean {
  // No rule at all is not a caller-varying rule. An absent `access.read` means the table's
  // readability is decided elsewhere, and treating that as identity-dependent would refuse public
  // caching on every model that never wrote one.
  if (!rule) return false

  switch (rule.type) {
    case "public":
    case "private":
      return false

    // "Any authenticated user" still distinguishes signed-in from anonymous, so a shared entry
    // could serve a member's view to a stranger.
    case "authenticated":
    case "role":
    case "owner":
      return true

    // Membership is per caller by construction.
    case "in":
    case "exists":
      return true

    case "compare":
      return operandIsIdentityDependent(rule.left) || operandIsIdentityDependent(rule.right)

    case "nullCheck":
      return operandIsIdentityDependent(rule.operand)

    case "any":
    case "all":
      return (rule.rules ?? []).some(isIdentityDependent)

    case "not":
      return rule.rule ? isIdentityDependent(rule.rule) : false

    default:
      // An unrecognised rule is assumed to depend on identity. Guessing the other way would share
      // a cache entry across callers on the strength of not recognising something.
      return true
  }
}
