/**
 * Just enough of a GraphQL reader to say which response key each selected field lands on.
 *
 * The client needs a query's shape (aliases, fragments, nested selections) to know which keys of
 * an answer hold a `JSON` scalar. It does not need argument values, variable types or directives,
 * so those are skipped as balanced token runs rather than parsed. A document this reader does not
 * understand (a type definition, a syntax error) comes back as null, and the caller then leaves the
 * answer as the server sent it.
 */

export type GraphqlOperationKind = "query" | "mutation" | "subscription"

export type GraphqlSelection =
  | { readonly kind: "field"; readonly key: string; readonly name: string; readonly selections: readonly GraphqlSelection[] }
  | { readonly kind: "spread"; readonly fragment: string }
  | { readonly kind: "inline"; readonly typeCondition: string | null; readonly selections: readonly GraphqlSelection[] }

type GraphqlOperation = { readonly kind: GraphqlOperationKind; readonly selections: readonly GraphqlSelection[] }
type GraphqlFragment ={ readonly typeCondition: string; readonly selections: readonly GraphqlSelection[] }

export type GraphqlDocument = {
  readonly operations: readonly GraphqlOperation[]
  readonly fragments: ReadonlyMap<string, GraphqlFragment>
}

type Token = { readonly kind: "punct" | "name" | "value"; readonly text: string }
type Read = { readonly token: Token | null; readonly end: number }

const PUNCTUATORS = new Set(["!", "$", "&", "(", ")", ":", "=", "@", "[", "]", "{", "|", "}"])
const IGNORED = /[\s,﻿]/
const NAME = /[_A-Za-z][_0-9A-Za-z]*/y
const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const LINE_END = /[\r\n]/g
const OPERATION_KINDS: ReadonlySet<string> = new Set(["query", "mutation", "subscription"])

/** Thrown inside the reader and caught at its edge: the document is not one it can read. */
class Unreadable extends Error {}

/** The document's operations and fragments, or null when it cannot be read. */
export function parseGraphqlDocument(source: string): GraphqlDocument | null {
  try {
    return new Parser(tokenize(source)).document()
  } catch (e) {
    if (e instanceof Unreadable) return null
    throw e
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  while (at < source.length) {
    const read = readToken(source, at)
    if (read.token !== null) tokens.push(read.token)
    at = read.end
  }
  return tokens
}

function readToken(source: string, at: number): Read {
  const char = source.charAt(at)
  if (IGNORED.test(char)) return { token: null, end: at + 1 }
  if (char === "#") return { token: null, end: lineEnd(source, at) }
  if (source.startsWith("...", at)) return { token: { kind: "punct", text: "..." }, end: at + 3 }
  if (PUNCTUATORS.has(char)) return { token: { kind: "punct", text: char }, end: at + 1 }
  if (source.startsWith('"""', at)) return { token: { kind: "value", text: '"""' }, end: blockStringEnd(source, at) }
  if (char === '"') return { token: { kind: "value", text: '"' }, end: stringEnd(source, at) }
  return matchWord(source, at)
}

function matchWord(source: string, at: number): Read {
  for (const [pattern, kind] of [[NAME, "name"], [NUMBER, "value"]] as const) {
    pattern.lastIndex = at
    const match = pattern.exec(source)
    if (match !== null) return { token: { kind, text: match[0] }, end: at + match[0].length }
  }
  throw new Unreadable(`unexpected character at ${at}`)
}

function lineEnd(source: string, at: number): number {
  LINE_END.lastIndex = at
  return LINE_END.exec(source) === null ? source.length : LINE_END.lastIndex - 1
}

function blockStringEnd(source: string, at: number): number {
  let i = at + 3
  while (i < source.length) {
    if (source.startsWith('\\"""', i)) i += 4
    else if (source.startsWith('"""', i)) return i + 3
    else i += 1
  }
  throw new Unreadable("unterminated block string")
}

function stringEnd(source: string, at: number): number {
  let i = at + 1
  while (i < source.length) {
    const char = source.charAt(i)
    if (char === "\\") i += 2
    else if (char === '"') return i + 1
    else if (char === "\n" || char === "\r") break
    else i += 1
  }
  throw new Unreadable("unterminated string")
}

class Parser {
  private at = 0
  constructor(private readonly tokens: readonly Token[]) {}

  document(): GraphqlDocument {
    const operations: GraphqlOperation[] = []
    const fragments = new Map<string, GraphqlFragment>()
    while (this.at < this.tokens.length) {
      if (this.isName("fragment")) {
        const [name, fragment] = this.fragment()
        fragments.set(name, fragment)
      } else {
        operations.push(this.operation())
      }
    }
    return { operations, fragments }
  }

  private operation(): GraphqlOperation {
    if (this.isPunct("{")) return { kind: "query", selections: this.selectionSet() }
    const kind = this.name()
    if (!isOperationKind(kind)) throw new Unreadable(`not an operation: ${kind}`)
    if (this.peek()?.kind === "name") this.name()
    if (this.isPunct("(")) this.skipBalanced()
    this.directives()
    return { kind, selections: this.selectionSet() }
  }

  private fragment(): [string, GraphqlFragment] {
    this.name()
    const name = this.name()
    if (this.name() !== "on") throw new Unreadable("a fragment needs a type condition")
    const typeCondition = this.name()
    this.directives()
    return [name, { typeCondition, selections: this.selectionSet() }]
  }

  private selectionSet(): GraphqlSelection[] {
    this.punct("{")
    const selections: GraphqlSelection[] = []
    while (!this.acceptPunct("}")) selections.push(this.selection())
    return selections
  }

  private selection(): GraphqlSelection {
    if (!this.acceptPunct("...")) return this.field()
    if (this.isName("on")) {
      this.name()
      const typeCondition = this.name()
      this.directives()
      return { kind: "inline", typeCondition, selections: this.selectionSet() }
    }
    if (this.peek()?.kind === "name") {
      const fragment = this.name()
      this.directives()
      return { kind: "spread", fragment }
    }
    this.directives()
    return { kind: "inline", typeCondition: null, selections: this.selectionSet() }
  }

  private field(): GraphqlSelection {
    const first = this.name()
    const name = this.acceptPunct(":") ? this.name() : first
    if (this.isPunct("(")) this.skipBalanced()
    this.directives()
    const selections = this.isPunct("{") ? this.selectionSet() : []
    return { kind: "field", key: first, name, selections }
  }

  private directives(): void {
    while (this.acceptPunct("@")) {
      this.name()
      if (this.isPunct("(")) this.skipBalanced()
    }
  }

  /** Skips `( ... )`, nested parentheses included. Strings are single tokens, so a `)` in one is safe. */
  private skipBalanced(): void {
    let depth = 0
    do {
      const token = this.next()
      if (token.kind === "punct" && token.text === "(") depth += 1
      if (token.kind === "punct" && token.text === ")") depth -= 1
    } while (depth > 0)
  }

  private peek(): Token | undefined {
    return this.tokens[this.at]
  }

  private next(): Token {
    const token = this.tokens[this.at]
    if (token === undefined) throw new Unreadable("the document ends early")
    this.at += 1
    return token
  }

  private name(): string {
    const token = this.next()
    if (token.kind !== "name") throw new Unreadable(`expected a name, found ${token.text}`)
    return token.text
  }

  private punct(text: string): void {
    if (!this.acceptPunct(text)) throw new Unreadable(`expected ${text}`)
  }

  private acceptPunct(text: string): boolean {
    if (!this.isPunct(text)) return false
    this.at += 1
    return true
  }

  private isPunct(text: string): boolean {
    const token = this.peek()
    return token?.kind === "punct" && token.text === text
  }

  private isName(text: string): boolean {
    const token = this.peek()
    return token?.kind === "name" && token.text === text
  }
}

function isOperationKind(text: string): text is GraphqlOperationKind {
  return OPERATION_KINDS.has(text)
}
