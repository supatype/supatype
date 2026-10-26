/**
 * Reading a rendered element's props. `react-test-renderer` types every prop as `any`, so each is
 * read as `unknown` and checked before a test uses it.
 */

import type { ReactTestInstance } from "react-test-renderer"

/** A prop that is a function: what it is called with is the test's to choose. */
function isHandler(value: unknown): value is (event?: unknown) => unknown {
  return typeof value === "function"
}

/** Call the handler `node` was given as `prop`, failing the test when it was given none. */
export function fire(node: ReactTestInstance, prop: string, event?: unknown): unknown {
  const handler: unknown = node.props[prop]
  if (!isHandler(handler)) throw new Error(`<${String(node.type)}> has no ${prop} handler`)
  return handler(event)
}

/** A prop's value when it is a string, else undefined. */
export function stringProp(node: ReactTestInstance, prop: string): string | undefined {
  const value: unknown = node.props[prop]
  return typeof value === "string" ? value : undefined
}
