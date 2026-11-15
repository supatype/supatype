/**
 * `Channel<>` declarations, read from a schema file into the wire shape of section 14.1 of the
 * realtime private channels plan.
 *
 * Declared the way `Bucket<>` is (an exported type alias the checker never evaluates), but kept out
 * of `type-extractor.ts`: it needs only the rule parser, which it is handed, so the two do not
 * import each other and the bucket code stays untouched.
 *
 * Everything a bad declaration can get wrong is refused here, at extract time, because the engine
 * turns a channel into SQL and the realtime server enforces it: a mistake that reaches either one
 * is an access rule that does not say what its author wrote.
 */
import ts from "typescript"
import type { ExtractedChannelAst, ChannelParamAst, ChannelParamKind } from "./schema-ast-v2.js"

type RuleJson = Record<string, unknown>

/** Reads one access rule's type node. `type-extractor.ts` supplies its own `parseAccessRule`. */
export type ChannelRuleParser = (node: ts.TypeNode) => RuleJson

const OPERATIONS = ["join", "send", "track"] as const
type Operation = (typeof OPERATIONS)[number]

const isOperation = (name: string): name is Operation => OPERATIONS.some((op) => op === name)

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const LITERAL_SEGMENT = /^[A-Za-z0-9_.-]+$/
const PARAM_SEGMENT = /^\{([^{}]*)\}$/

type Segment =
  | { kind: "literal"; text: string }
  | { kind: "param"; name: string }
  | { kind: "wildcard" }

// ─── Pattern ────────────────────────────────────────────────────────────────

function refusePatternShape(channel: string, pattern: string): void {
  if (pattern.startsWith("realtime:") || pattern.startsWith("_supatype")) {
    throw new Error(
      `Channel "${channel}": the pattern "${pattern}" starts with realtime: or _supatype, ` +
        "which are reserved for Supatype's own topics. Pick another prefix.",
    )
  }
}

function parseSegment(channel: string, pattern: string, text: string): Segment {
  if (text === "") {
    throw new Error(`Channel "${channel}": the pattern "${pattern}" has an empty segment. Segments are separated by one colon.`)
  }
  if (text === "*") return { kind: "wildcard" }
  const param = PARAM_SEGMENT.exec(text)
  if (param !== null) {
    const name = param[1] ?? ""
    if (!IDENTIFIER.test(name)) {
      throw new Error(`Channel "${channel}": "{${name}}" in "${pattern}" is not a parameter name. Use letters, digits and _.`)
    }
    return { kind: "param", name }
  }
  if (text.includes("{") || text.includes("}")) {
    throw new Error(
      `Channel "${channel}": "${text}" in "${pattern}" mixes a parameter with other text. ` +
        "A {parameter} must be a whole segment between colons.",
    )
  }
  if (!LITERAL_SEGMENT.test(text)) {
    throw new Error(
      `Channel "${channel}": the segment "${text}" in "${pattern}" may hold only letters, digits, _, - and ".` +
        " Put anything that varies in a {parameter}.",
    )
  }
  return { kind: "literal", text }
}

/** A pattern's segments, refusing every way it can be malformed. */
export function parseChannelPattern(channel: string, pattern: string): Segment[] {
  refusePatternShape(channel, pattern)
  const segments = pattern.split(":").map((text) => parseSegment(channel, pattern, text))
  const wildcard = segments.findIndex((segment) => segment.kind === "wildcard")
  if (wildcard !== -1 && wildcard !== segments.length - 1) {
    throw new Error(`Channel "${channel}": the "*" in "${pattern}" must be the final segment.`)
  }
  if (wildcard === 0) {
    throw new Error(
      `Channel "${channel}": "${pattern}" would match every topic. Put at least one literal segment before the "*".`,
    )
  }
  const seen = new Set<string>()
  for (const segment of segments) {
    if (segment.kind !== "param") continue
    if (seen.has(segment.name)) {
      throw new Error(`Channel "${channel}": the pattern "${pattern}" uses {${segment.name}} more than once.`)
    }
    seen.add(segment.name)
  }
  return segments
}

function segmentsCanMatchTogether(a: Segment, b: Segment): boolean {
  if (a.kind === "literal" && b.kind === "literal") return a.text === b.text
  return true
}

/**
 * Whether one topic can match both patterns. A parameter matches any one segment, so it meets
 * any literal; a final `*` meets anything with at least one segment left where it sits.
 */
function patternsOverlap(a: Segment[], b: Segment[]): boolean {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i += 1) {
    const left = a[i]
    const right = b[i]
    if (left === undefined || right === undefined) return false
    if (left.kind === "wildcard" || right.kind === "wildcard") return true
    if (!segmentsCanMatchTogether(left, right)) return false
  }
  return a.length === b.length
}

/** Refuse two declarations that can match one topic, naming both. */
export function assertChannelsDoNotOverlap(channels: readonly ExtractedChannelAst[]): void {
  const parsed = channels.map((channel) => ({ channel, segments: parseChannelPattern(channel.name, channel.pattern) }))
  for (const [i, first] of parsed.entries()) {
    for (const second of parsed.slice(i + 1)) {
      if (first.channel.name === second.channel.name) {
        throw new Error(`Channel "${first.channel.name}" is declared twice. Use one export per channel.`)
      }
      if (!patternsOverlap(first.segments, second.segments)) continue
      throw new Error(
        `Channels "${first.channel.name}" (${first.channel.pattern}) and "${second.channel.name}" ` +
          `(${second.channel.pattern}) can both match one topic, so it would have two sets of rules. ` +
          "Write them as one declaration, or make a literal segment differ.",
      )
    }
  }
}

// ─── Parameters ─────────────────────────────────────────────────────────────

function paramKind(node: ts.TypeNode): ChannelParamKind | undefined {
  if (node.kind === ts.SyntaxKind.StringKeyword) return "string"
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return undefined
  if (node.typeName.text === "UUID") return "uuid"
  if (node.typeName.text === "Int") return "integer"
  return undefined
}

function propertyName(name: ts.PropertyName, sourceFile: ts.SourceFile): string {
  return ts.isStringLiteral(name) ? name.text : name.getText(sourceFile)
}

function readParams(channel: string, node: ts.TypeNode | undefined, sourceFile: ts.SourceFile): Map<string, ChannelParamKind> {
  const out = new Map<string, ChannelParamKind>()
  if (node === undefined) return out
  if (!ts.isTypeLiteralNode(node)) {
    throw new Error(`Channel "${channel}": params must be an object type, as in { id: UUID }.`)
  }
  for (const member of node.members) {
    if (!ts.isPropertySignature(member) || member.type === undefined) continue
    const name = propertyName(member.name, sourceFile)
    const kind = paramKind(member.type)
    if (kind === undefined) {
      throw new Error(
        `Channel "${channel}": parameter "${name}" has type ${member.type.getText(sourceFile)}. Use UUID, string or Int.`,
      )
    }
    out.set(name, kind)
  }
  return out
}

/** The parameters in pattern order, refusing any the pattern and `params` do not agree on. */
function matchParams(
  channel: string,
  pattern: string,
  segments: readonly Segment[],
  typed: Map<string, ChannelParamKind>,
): ChannelParamAst[] {
  const named = segments.flatMap((segment) => (segment.kind === "param" ? [segment.name] : []))
  for (const name of named) {
    if (!typed.has(name)) {
      throw new Error(
        `Channel "${channel}": the pattern "${pattern}" has a parameter {${name}} that params does not type. ` +
          `Add params: { ${name}: UUID }.`,
      )
    }
  }
  for (const name of typed.keys()) {
    if (!named.includes(name)) {
      throw new Error(`Channel "${channel}": params has "${name}", which does not appear in the pattern "${pattern}".`)
    }
  }
  return named.map((name) => ({ name, type: typed.get(name) ?? "string" }))
}

// ─── Rules ──────────────────────────────────────────────────────────────────

interface RuleScope {
  channel: string
  pattern: string
  operation: Operation
  params: ReadonlySet<string>
}

function parameterList(scope: RuleScope): string {
  return scope.params.size === 0 ? "none" : [...scope.params].join(", ")
}

function refuseUnknownColumn(scope: RuleScope, column: unknown): void {
  if (typeof column !== "string" || scope.params.has(column)) return
  throw new Error(
    `The ${scope.operation} rule of ${scope.channel} names "${column}", which is not a parameter of ` +
      `${scope.pattern}. Declared parameters: ${parameterList(scope)}. ` +
      'Inside a Rows<> filter, write Param<"name"> to use a parameter.',
  )
}

function checkOperand(scope: RuleScope, operand: unknown, inFilter: boolean): void {
  if (!isRecord(operand)) return
  if (operand["kind"] === "param") {
    if (typeof operand["name"] === "string" && !scope.params.has(operand["name"])) {
      throw new Error(
        `Param<"${operand["name"]}"> in the ${scope.operation} rule of ${scope.channel} is not a parameter of ` +
          `${scope.pattern}. Declared parameters: ${parameterList(scope)}.`,
      )
    }
    return
  }
  if (inFilter) return
  if (operand["kind"] === "column" || operand["kind"] === "length" || operand["kind"] === "itemCount") {
    refuseUnknownColumn(scope, operand["name"] ?? operand["column"])
  }
}

function checkSource(scope: RuleScope, source: unknown): void {
  if (!isRecord(source) || source["kind"] !== "rows" || source["where"] === undefined) return
  checkRule(scope, source["where"], { inFilter: true, contentOk: false })
}

interface RulePosition {
  /** Inside a `Rows<>` filter, where a bare string is a column of the source table. */
  inFilter: boolean
  /** Where `Event<>` and `Payload<>` may stand: `send`, reached through `All` only. */
  contentOk: boolean
}

function refuseContentRule(scope: RuleScope, name: "Event" | "Payload"): never {
  if (scope.operation !== "send") {
    throw new Error(
      `${name}<> is only valid inside send, but the ${scope.operation} rule of ${scope.channel} uses it.`,
    )
  }
  throw new Error(
    `${name}<> in the send rule of ${scope.channel} must sit directly in All<[...]>, ` +
      "not under Any or Not: the database cannot say what it means there.",
  )
}

function checkRule(scope: RuleScope, rule: unknown, at: RulePosition): void {
  if (!isRecord(rule)) return
  switch (rule["type"]) {
    case "any":
      for (const inner of asList(rule["rules"])) checkRule(scope, inner, { ...at, contentOk: false })
      return
    case "all":
      for (const inner of asList(rule["rules"])) checkRule(scope, inner, at)
      return
    case "not":
      checkRule(scope, rule["rule"], { ...at, contentOk: false })
      return
    case "event":
    case "payload":
      if (!at.contentOk) refuseContentRule(scope, rule["type"] === "event" ? "Event" : "Payload")
      return
    case "compare":
      checkOperand(scope, rule["left"], at.inFilter)
      checkOperand(scope, rule["right"], at.inFilter)
      return
    case "nullCheck":
      checkOperand(scope, rule["operand"], at.inFilter)
      return
    case "in":
      if (!at.inFilter) refuseUnknownColumn(scope, rule["column"])
      checkSource(scope, rule["source"])
      return
    case "exists":
      checkSource(scope, rule["source"])
      return
    case "matches":
      if (!at.inFilter) refuseUnknownColumn(scope, rule["column"])
      return
    case "owner":
      if (!at.inFilter) {
        throw new Error(`Owner<> in the ${scope.operation} rule of ${scope.channel} needs a row, and a channel has none.`)
      }
      return
    default:
      return
  }
}

function isRecord(value: unknown): value is RuleJson {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

// ─── Event and Payload ──────────────────────────────────────────────────────

function stringLiteral(node: ts.TypeNode | undefined, rule: string, what: string): string {
  if (node !== undefined && ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return node.literal.text
  throw new Error(`${rule}<> takes ${what} as a string literal, as in ${rule}<"bid">.`)
}

/** `Event<"bid">` as a send-rule node. */
export function parseEventRule(args: readonly ts.TypeNode[]): RuleJson {
  const name = stringLiteral(args[0], "Event", "the event name")
  if (name === "") throw new Error("Event<> needs a non-empty event name.")
  return { type: "event", name }
}

function numberLiteral(node: ts.TypeNode, key: string): number {
  if (ts.isLiteralTypeNode(node) && ts.isNumericLiteral(node.literal)) return Number(node.literal.text)
  if (
    ts.isLiteralTypeNode(node) &&
    ts.isPrefixUnaryExpression(node.literal) &&
    node.literal.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.literal.operand)
  ) {
    return -Number(node.literal.operand.text)
  }
  throw new Error(`Payload<> check: "${key}" must be a number literal.`)
}

const CHECK_BOUNDS: Readonly<Record<string, readonly string[]>> = {
  string: ["maxLength"],
  number: ["min", "max"],
  boolean: [],
  required: [],
}

function readCheckMembers(check: ts.TypeLiteralNode): Map<string, ts.TypeNode> {
  const members = new Map<string, ts.TypeNode>()
  for (const member of check.members) {
    if (!ts.isPropertySignature(member) || member.type === undefined) continue
    const key = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : ""
    members.set(key, member.type)
  }
  return members
}

function parsePayloadCheck(node: ts.TypeNode | undefined): RuleJson {
  if (node === undefined || !ts.isTypeLiteralNode(node)) {
    throw new Error('Payload<> takes a check object as its second argument, as in { kind: "number"; min: 1 }.')
  }
  const members = readCheckMembers(node)
  const kind = stringLiteral(members.get("kind"), "Payload", "the check kind")
  const allowed = CHECK_BOUNDS[kind]
  if (allowed === undefined) {
    throw new Error(`Payload<> check kind "${kind}" is not one of number, string, boolean or required.`)
  }
  const check: RuleJson = { kind }
  for (const [key, valueNode] of members) {
    if (key === "kind") continue
    if (!allowed.includes(key)) {
      throw new Error(`Payload<> check: "${key}" is not a bound of a ${kind} check.`)
    }
    check[key] = numberLiteral(valueNode, key)
  }
  refuseBadBounds(check)
  return check
}

function refuseBadBounds(check: RuleJson): void {
  const { maxLength, min, max } = check
  if (typeof maxLength === "number" && (!Number.isInteger(maxLength) || maxLength < 1)) {
    throw new Error("Payload<> check: maxLength must be a positive whole number.")
  }
  if (typeof min === "number" && typeof max === "number" && min > max) {
    throw new Error(`Payload<> check: min is greater than max (${min} > ${max}).`)
  }
}

/** `Payload<"amount", { kind: "number"; min: 1 }>` as a send-rule node. */
export function parsePayloadRule(args: readonly ts.TypeNode[]): RuleJson {
  const field = stringLiteral(args[0], "Payload", "the field name")
  if (!IDENTIFIER.test(field)) {
    throw new Error(`Payload<"${field}", ...> does not name a payload field. Use letters, digits and _.`)
  }
  return { type: "payload", field, check: parsePayloadCheck(args[1]) }
}

/** `Param<"id">` as an operand. */
export function parseParamOperand(args: readonly ts.TypeNode[]): RuleJson {
  const name = stringLiteral(args[0], "Param", "the parameter name")
  if (!IDENTIFIER.test(name)) throw new Error(`Param<"${name}"> does not name a channel parameter.`)
  return { kind: "param", name }
}

// ─── Declaration ────────────────────────────────────────────────────────────

function readAccess(
  channel: string,
  node: ts.TypeNode | undefined,
  scope: Omit<RuleScope, "operation">,
  parseRule: ChannelRuleParser,
): ExtractedChannelAst["access"] {
  const access: ExtractedChannelAst["access"] = { join: null, send: null, track: null }
  const members = node !== undefined && ts.isTypeLiteralNode(node) ? node.members : []
  let declared = 0
  for (const member of members) {
    if (!ts.isPropertySignature(member) || member.type === undefined) continue
    const operation = ts.isIdentifier(member.name) ? member.name.text : ""
    if (!isOperation(operation)) {
      throw new Error(`Channel "${channel}": access has "${operation}". A channel has three operations: join, send or track.`)
    }
    const rule = parseRule(member.type)
    checkRule({ ...scope, operation }, rule, { inFilter: false, contentOk: operation === "send" })
    access[operation] = rule
    declared += 1
  }
  if (declared === 0) {
    throw new Error(
      `Channel "${channel}" declares no access, so nobody could use it. Declare at least one of join, send or track.`,
    )
  }
  return access
}

function memberType(config: ts.TypeLiteralNode, key: string): ts.TypeNode | undefined {
  for (const member of config.members) {
    if (ts.isPropertySignature(member) && ts.isIdentifier(member.name) && member.name.text === key) return member.type
  }
  return undefined
}

function readChannel(
  alias: ts.TypeAliasDeclaration,
  reference: ts.TypeReferenceNode,
  sourceFile: ts.SourceFile,
  parseRule: ChannelRuleParser,
): ExtractedChannelAst {
  const name = alias.name.text
  const [patternArg, configArg] = reference.typeArguments ?? []
  const pattern = patternArg !== undefined && ts.isLiteralTypeNode(patternArg) && ts.isStringLiteral(patternArg.literal)
    ? patternArg.literal.text
    : undefined
  if (pattern === undefined) {
    throw new Error(`Channel "${name}": Channel<> takes the pattern as a string literal, as in Channel<"lot:{id}", { ... }>.`)
  }
  if (configArg === undefined || !ts.isTypeLiteralNode(configArg)) {
    throw new Error(`Channel "${name}": Channel<"${pattern}", ...> needs a config object with access, as in { access: { join: LoggedIn } }.`)
  }
  const segments = parseChannelPattern(name, pattern)
  const params = matchParams(name, pattern, segments, readParams(name, memberType(configArg, "params"), sourceFile))
  const scope = { channel: name, pattern, params: new Set(params.map((param) => param.name)) }
  const access = readAccess(name, memberType(configArg, "access"), scope, parseRule)
  return { name, pattern, params, access }
}

/** Every `Channel<>` alias in a file, in declaration order. */
export function collectChannels(sourceFile: ts.SourceFile, parseRule: ChannelRuleParser): ExtractedChannelAst[] {
  const found: ExtractedChannelAst[] = []
  for (const stmt of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(stmt) || !ts.isTypeReferenceNode(stmt.type)) continue
    if (!ts.isIdentifier(stmt.type.typeName) || stmt.type.typeName.text !== "Channel") continue
    found.push(readChannel(stmt, stmt.type, sourceFile, parseRule))
  }
  return found
}

// ─── Warnings ───────────────────────────────────────────────────────────────

/** Whether every leaf of the rule is an `Event` or a `Payload`: the engine's `is_content`. */
function isContent(rule: unknown): boolean {
  if (!isRecord(rule)) return false
  if (rule["type"] === "event" || rule["type"] === "payload") return true
  if (rule["type"] === "not") return isContent(rule["rule"])
  if (rule["type"] !== "any" && rule["type"] !== "all") return false
  const rules = asList(rule["rules"])
  return rules.length > 0 && rules.every(isContent)
}

function hasContent(rule: unknown): boolean {
  if (!isRecord(rule)) return false
  if (rule["type"] === "event" || rule["type"] === "payload") return true
  if (rule["type"] === "not") return hasContent(rule["rule"])
  return asList(rule["rules"]).some(hasContent)
}

/** The engine's `flatten_all`: nested `All`s that hold content are opened into one list. */
function flattenAll(rules: readonly unknown[]): unknown[] {
  return rules.flatMap((rule) =>
    isRecord(rule) && rule["type"] === "all" && hasContent(rule) ? flattenAll(asList(rule["rules"])) : [rule],
  )
}

/**
 * The tests of a `send` rule that the database decides: what is left once `Event` and `Payload` are
 * taken out, as `split_send_rule` in the engine's `parser/channels.rs` takes them. A rule of content
 * alone leaves none, and so does a top-level `All` whose other members are content.
 */
function callerTests(send: unknown): unknown[] {
  if (isContent(send)) return []
  if (!isRecord(send) || send["type"] !== "all") return [send]
  return flattenAll(asList(send["rules"])).filter((rule) => !isContent(rule))
}

/** True for a send rule that tests the message and nothing about who sends it. */
function sendTestsNoCaller(send: unknown): boolean {
  if (!hasContent(send)) return false
  return callerTests(send).every((rule) => isRecord(rule) && rule["type"] === "public")
}

/**
 * One warning per channel whose `send` rule tests only the event or the payload. `Event` and
 * `Payload` compile to TRUE in the database, so a rule made of them alone admits every caller,
 * anon included. Not an error: an open channel with a vetted event is a legitimate design.
 */
export function channelWarnings(channels: readonly ExtractedChannelAst[]): string[] {
  return channels
    .filter((channel) => sendTestsNoCaller(channel.access.send))
    .map(
      (channel) =>
        `Channel "${channel.name}": the send rule does not check who is sending, so any caller, ` +
        `anon included, may send the events it allows. Add a caller test, for example ` +
        `send: All<[LoggedIn, Event<"bid">]>.`,
    )
}

// ─── Channel-only nodes elsewhere ───────────────────────────────────────────

/** The name a channel-only node is written with, or undefined for any other node. */
function channelOnlyName(node: RuleJson): string | undefined {
  if (node["kind"] === "param") return "Param<>"
  if (node["type"] === "event") return "Event<>"
  if (node["type"] === "payload") return "Payload<>"
  return undefined
}

function channelOnlyNode(json: unknown): string | undefined {
  if (Array.isArray(json)) return json.map(channelOnlyNode).find((found) => found !== undefined)
  if (!isRecord(json)) return undefined
  return channelOnlyName(json) ?? Object.values(json).map(channelOnlyNode).find((found) => found !== undefined)
}

/**
 * Refuse a channel-only operand or rule in a rule that is not a channel's. `rules` is whatever
 * holds the rule JSON, and `owner` what to call it in the error (`model "Doc"`).
 */
export function refuseChannelOnlyNodes(owner: string, rules: unknown): void {
  const found = channelOnlyNode(rules)
  if (found === undefined) return
  const where = found === "Param<>" ? "a Channel rule" : "the send rule of a Channel"
  throw new Error(`${found} is only valid in ${where}, but ${owner} uses it.`)
}
