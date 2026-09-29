/**
 * Collect a seed's builder calls into an IR document.
 *
 * The only genuinely new file in the CLI half of this: everything else is rewiring. What it
 * does is narrow. It records calls in the order they were made, encodes each value into the
 * shape the engine reads, and hands back a document. It resolves nothing, orders nothing,
 * validates nothing and connects to nothing, because the engine does all four and doing any
 * of them twice is how the two ends come to disagree.
 *
 * **Labels are assigned lazily.** A `create` becomes a referenceable operation only when
 * something actually reads a property off what it returned. Assigning one to every operation
 * would put an `id` in the IR for rows nobody points at, which is noise in a document people
 * read and diff.
 */

import type {
  DefaultExpr,
  ModelApi,
  ModelManifest,
  NumericValue,
  Operand,
  Predicate,
  RefValue,
  SeedCondition,
  SeedConditionInput,
  SeedData,
  SeedDb,
  SeedIr,
  SeedOperation,
  SeedValue,
} from "./seed.js"

/** A model's own name and the facts the encoder needs about its columns. */
export type Manifest = Readonly<Record<string, ModelManifest>>

/** What a collector hands back once the seed has run. */
export interface CollectedIr {
  ir: SeedIr
  /** The document as the engine will read it, which is what the ledger hashes. */
  json: string
}

/** One operation, still mutable while the seed is running. */
interface Pending {
  operation: SeedOperation
  /** Set the first time something reads a property off this operation's result. */
  label?: string
}

export class SeedCollector {
  private readonly manifest: Manifest
  private readonly byModel: Map<string, ModelManifest>
  /** The block currently being collected into: the document, or a `$if` body. */
  private readonly stack: SeedOperation[][] = []
  private readonly root: SeedOperation[] = []
  private labels = 0

  constructor(
    private readonly fingerprint: string,
    manifest: Manifest,
  ) {
    this.manifest = manifest
    this.byModel = new Map(Object.values(manifest).map((entry) => [entry.model, entry]))
    this.stack.push(this.root)
  }

  /** The `db` a seed's default export is handed. */
  db(): SeedDb {
    const api: Record<string, unknown> = {}
    for (const [accessor, entry] of Object.entries(this.manifest)) {
      api[accessor] = this.modelApi(entry)
    }
    api["$if"] = (condition: SeedConditionInput, body: () => void): void => {
      this.group(condition, body)
    }
    api["$sql"] = (text: string, params?: readonly SeedValue[]): void => {
      // Always present, even when empty: the engine defaults it either way, and a document
      // whose shape changes with its contents is harder to read and to diff.
      this.push({ op: "sql", text, params: params === undefined ? [] : [...params] })
    }
    return api as SeedDb
  }

  /** The document, with every label that was actually used written in. */
  finish(): CollectedIr {
    const ir: SeedIr = {
      irVersion: 1,
      schemaFingerprint: this.fingerprint,
      operations: this.root,
    }
    return { ir, json: JSON.stringify(ir, null, 2) }
  }

  // --- Operations ---

  private modelApi(entry: ModelManifest): ModelApi<SeedData, SeedData, Record<string, RefValue>> {
    return {
      create: (data, options) => {
        const pending: Pending = {
          operation: { op: "create", model: entry.model, data: this.encodeRow(entry, data) },
        }
        if (options?.id !== undefined) this.name(pending, options.id)
        this.push(pending.operation)
        return this.reference(pending)
      },

      createMany: (rows) => {
        this.push({
          op: "createMany",
          model: entry.model,
          rows: rows.map((row) => this.encodeRow(entry, row)),
        })
      },

      upsert: ({ where, data, id }) => {
        const pending: Pending = {
          operation: {
            op: "upsert",
            model: entry.model,
            where: this.encodeRow(entry, where),
            data: this.encodeRow(entry, data),
          },
        }
        if (id !== undefined) this.name(pending, id)
        this.push(pending.operation)
        return this.reference(pending)
      },
    }
  }

  private group(condition: SeedConditionInput, body: () => void): void {
    const operations: SeedOperation[] = []
    this.stack.push(operations)
    try {
      body()
    } finally {
      // Popped in a `finally` so a seed that throws inside a `$if` does not leave every
      // later operation collecting into a block that is never emitted.
      this.stack.pop()
    }
    this.push({ op: "group", if: encodeCondition(condition), operations })
  }

  private push(operation: SeedOperation): void {
    const block = this.stack[this.stack.length - 1]
    if (block === undefined) throw new Error("the seed collector lost its block")
    block.push(operation)
  }

  // --- References ---

  private name(pending: Pending, label?: string): string {
    if (pending.label !== undefined) return pending.label
    this.labels += 1
    pending.label = label ?? `op${this.labels}`
    const operation = pending.operation
    if (operation.op === "create" || operation.op === "upsert") {
      operation.id = pending.label
    }
    return pending.label
  }

  /**
   * What an operation hands back.
   *
   * A proxy rather than a plain object, because the columns a seed may reference are the
   * model's columns and building one property per column per row would cost more than the
   * seed itself. Reading a property is also what tells the collector this operation needs a
   * label at all.
   */
  private reference(pending: Pending): Record<string, RefValue> {
    return new Proxy({} as Record<string, RefValue>, {
      get: (_target, property): RefValue | undefined => {
        // A proxy gets asked about `then` when it is awaited or resolved, and about
        // symbols by anything that inspects it. Answering with a reference would make a
        // seed that awaits a builder call hang on a thenable that never settles.
        if (typeof property !== "string" || property === "then") return undefined
        return { $ref: `${this.name(pending)}.${property}` }
      },
    })
  }

  // --- Values ---

  private encodeRow(entry: ModelManifest, row: SeedData): SeedData {
    const out: SeedData = {}
    for (const [key, value] of Object.entries(row)) {
      if (value === undefined) continue
      out[key] = this.encode(entry, key, value)
    }
    return out
  }

  private encode(entry: ModelManifest, key: string, value: SeedValue): SeedValue {
    if (isPassThrough(value)) return value

    const relation = entry.relations[key]
    if (relation !== undefined) {
      const nested = this.nested(relation.target, value)
      if (nested !== undefined) return nested
    }

    if (value instanceof Date) return value.toISOString()
    if (typeof value === "bigint") return (value as bigint).toString()

    // The column's kind decides the encoding, and only the manifest knows it: a decimal
    // sent as a JSON number round-trips through a double and stops being the value the
    // column holds.
    if (typeof value === "number" && entry.numeric.includes(key)) {
      return { $numeric: String(value) } satisfies NumericValue
    }
    if (typeof value === "string" && entry.numeric.includes(key)) {
      return { $numeric: value } satisfies NumericValue
    }

    if (Array.isArray(value)) return value.map((item) => this.encodeLoose(item))
    return value
  }

  /**
   * A relation's input, with its rows encoded against the model they will be written to.
   *
   * Returns `undefined` when the value is not one of the relation shapes, so an ordinary
   * value on a field that happens to share a relation's name is left alone.
   */
  private nested(target: string, value: SeedValue): SeedValue | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
    const shape = value as Record<string, unknown>
    const entry = this.byModel.get(target)

    if ("connect" in shape) {
      const where = shape["connect"]
      if (entry === undefined || where === null || typeof where !== "object") return undefined
      return { connect: this.encodeRow(entry, where as SeedData) }
    }
    if ("create" in shape) {
      const rows = toRows(shape["create"])
      if (entry === undefined || rows === undefined) return undefined
      return { create: rows.map((row) => this.encodeRow(entry, row)) }
    }
    if ("createMany" in shape) {
      const rows = toRows(shape["createMany"])
      if (entry === undefined || rows === undefined) return undefined
      return { createMany: rows.map((row) => this.encodeRow(entry, row)) }
    }
    return undefined
  }

  /** A value with no column to consult, such as an element of an array. */
  private encodeLoose(value: SeedValue): SeedValue {
    if (isPassThrough(value)) return value
    if (value instanceof Date) return value.toISOString()
    if (typeof value === "bigint") return (value as bigint).toString()
    if (Array.isArray(value)) return value.map((item) => this.encodeLoose(item))
    return value
  }
}

/**
 * A `hasOne` nests one row and a `hasMany` nests several; the IR carries a list either way.
 *
 * Normalised here rather than in the generated builder, so six more generators do not each
 * have to remember it.
 */
function toRows(value: unknown): SeedData[] | undefined {
  if (Array.isArray(value)) return value as SeedData[]
  if (value !== null && typeof value === "object") return [value as SeedData]
  return undefined
}

/**
 * Values that are already in the shape the engine reads.
 *
 * `expr.now()` is literally `{ kind: "now" }` and a reference is literally `{ $ref: ... }`,
 * so encoding them again would wrap an operand in a decimal or walk into a proxy.
 */
function isPassThrough(value: SeedValue): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const shape = value as Record<string, unknown>
  return (
    "$ref" in shape ||
    "$numeric" in shape ||
    "$default" in shape ||
    typeof shape["kind"] === "string"
  )
}

/** The surface a seed writes, in the shape the IR carries. */
export function encodeCondition(condition: SeedConditionInput): SeedCondition {
  if ("environment" in condition) {
    return { kind: "environment", name: condition.environment }
  }
  if ("exists" in condition) {
    return scoped("exists", condition.exists)
  }
  return scoped("notExists", condition.notExists)
}

function scoped(
  kind: "exists" | "notExists",
  target: { model: string; where?: Predicate },
): SeedCondition {
  return {
    kind,
    model: target.model,
    ...(target.where !== undefined ? { where: target.where } : {}),
  }
}

/** Re-exported for the runner, which has no reason to know these came from `seed.ts`. */
export type { DefaultExpr, Operand, RefValue, SeedIr, SeedOperation, SeedValue }
