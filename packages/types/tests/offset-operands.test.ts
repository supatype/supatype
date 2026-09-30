/**
 * `After` / `Before`: the composable time operands.
 *
 * The behaviour worth pinning is not that a valid spec compiles, it is that an invalid
 * one does not. A plain `extends TimeInterval` accepts `{ dayz: 30 }`, because every unit
 * is optional and excess-property checking does not reach a type argument. The engine
 * then reads the typo as absent, the interval as empty, and refuses the push: correct,
 * but the author hears about it minutes later instead of in the editor.
 */

import { describe, expect, it } from "vitest"
import type {
  After,
  Before,
  ExactInterval,
  Gte,
  Lte,
  Now,
  StartOf,
  TimeInterval,
} from "../src/index.js"

/** Compiles only when `T` is exactly `true`. */
type Expect<T extends true> = T
type IsAssignable<TFrom, TTo> = [TFrom] extends [TTo] ? true : false

describe("After and Before", () => {
  it("accept a clock base with a single unit", () => {
    type Rule = Lte<"updated_at", After<Now, { days: 30 }>>
    type _ok = Expect<IsAssignable<Rule, Rule>>
    expect(true).toBe(true)
  })

  it("accept a truncation base with a multi-unit interval", () => {
    // The composition `Ago` and `FromNow` could not express: thirty days from now,
    // at 09:00, rather than at whatever time the push happened to run.
    type Rule = Gte<"starts_at", After<StartOf<"day">, { days: 30; hours: 9 }>>
    type _ok = Expect<IsAssignable<Rule, Rule>>
    expect(true).toBe(true)
  })

  it("accept Before as well as After", () => {
    type Rule = Gte<"created_at", Before<Now, { weeks: 2 }>>
    type _ok = Expect<IsAssignable<Rule, Rule>>
    expect(true).toBe(true)
  })

  it("accept every unit", () => {
    type All = After<
      Now,
      { years: 1; months: 2; weeks: 3; days: 4; hours: 5; minutes: 6; seconds: 7 }
    >
    type _ok = Expect<IsAssignable<All, All>>
    expect(true).toBe(true)
  })

  it("reject a misspelled unit alongside a real one", () => {
    // The case that needs `ExactInterval`, and the one a real schema hits: a typo
    // *beside* a correct unit.
    //
    // A lone `{ dayz: 30 }` is already refused without any help, because `TimeInterval`
    // has only optional properties and TypeScript's weak-type check rejects an object
    // sharing none of them. That makes it useless as a test: it passes whether or not
    // the constraint does anything. `{ days: 30; dayz: 5 }` shares `days`, so the weak
    // type check is satisfied and excess-property checking does not reach a type
    // argument, leaving `ExactInterval` as the only thing that can catch it.
    type Typo = { days: 30; dayz: 5 }
    type _rejected = Expect<IsAssignable<Typo, ExactInterval<Typo>> extends true ? false : true>

    // @ts-expect-error `dayz` is not a unit of time
    type _Bad = After<Now, { days: 30; dayz: 5 }>
    expect(true).toBe(true)
  })

  it("still reject a lone misspelled unit", () => {
    // Caught by the weak-type check rather than by `ExactInterval`, but worth pinning:
    // it is the shape an author is most likely to write.
    // @ts-expect-error `dayz` is not a unit of time
    type _Bad = After<Now, { dayz: 30 }>
    expect(true).toBe(true)
  })

  it("reject a base that is not a point in time", () => {
    // A column depends on the row, so it is not something an offset can be measured
    // from. The engine refuses it too, but this is the editor saying so first.
    // @ts-expect-error a column is not an offsetable base
    type _Bad = After<"created_at", { days: 1 }>
    expect(true).toBe(true)
  })

  it("keep a valid interval assignable to TimeInterval", () => {
    type _ok = Expect<IsAssignable<{ days: 30; hours: 9 }, TimeInterval>>
    expect(true).toBe(true)
  })
})
