import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isIdentityDependent, type AccessRuleNode } from "../src/cache-identity-scope.js"

/**
 * The corpus is shared with supatype-server's `internal/studiobootstrap.IsIdentityDependent`,
 * which answers the same question at request time. Two implementations of one rule drift, and the
 * drift is silent in both directions: a push that permits `public: true` where the runtime refuses
 * to share is a feature that quietly does nothing; a push that permits it where the runtime *does*
 * share is a data leak. Running both against one file is what makes the pair falsifiable.
 */
interface Corpus {
  cases: { name: string; rule: AccessRuleNode | null; identityDependent: boolean }[]
}

const corpus = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "identity-scope-corpus.json"), "utf8"),
) as Corpus

describe("the identity-dependence rule, against the shared corpus", () => {
  it.each(corpus.cases)("$name", ({ rule, identityDependent }) => {
    expect(isIdentityDependent(rule)).toBe(identityDependent)
  })

  it("covers both answers, so a stuck implementation cannot pass", () => {
    // A classifier hardcoded to `true` is the dangerous failure — it refuses every public cache
    // and looks conservative while making the feature unusable. One hardcoded to `false` is the
    // leak. The corpus has to be able to catch both.
    const yes = corpus.cases.filter(c => c.identityDependent).length
    expect(yes).toBeGreaterThan(5)
    expect(corpus.cases.length - yes).toBeGreaterThan(5)
  })
})

describe("the distinction the whole feature turns on", () => {
  it("does not confuse row-dependence with caller-dependence", () => {
    // `Lte<"published_at", Now>` changes which rows come back, and changes over time, and is the
    // same for every caller. Refusing it would remove the case public caching exists for.
    const publishedContent: AccessRuleNode = {
      type: "compare",
      left: { kind: "column" },
      right: { kind: "now" },
    }
    expect(isIdentityDependent(publishedContent)).toBe(false)
  })

  it("catches the same shape when the operand is the caller", () => {
    const ownRows: AccessRuleNode = {
      type: "compare",
      left: { kind: "column" },
      right: { kind: "authUid" },
    }
    expect(isIdentityDependent(ownRows)).toBe(true)
  })

  it("fails closed on anything it does not recognise", () => {
    // A rule type added to the language and not to this file must refuse sharing, not permit it.
    expect(isIdentityDependent({ type: "aRuleInventedTomorrow" })).toBe(true)
  })
})
