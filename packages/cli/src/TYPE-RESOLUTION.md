# Type Resolution in the Schema Extractor

`type-extractor.ts` converts TypeScript type definitions into `ExtractedSchemaAst` —
the JSON handed to the engine binary for SQL generation and client type output.

This document explains how type names are resolved, what patterns are supported,
and how the three-tier fallback chain works.

---

## The Problem

The extractor uses the TypeScript **parser only** (`ts.createSourceFile`), not the
full type checker. This is fast and requires no `tsconfig.json`, but it means the
extractor only sees raw source text — it cannot evaluate what a type alias resolves to.

The consequence is that any indirection breaks resolution:

```typescript
// Works — extractor sees "Optional" literally
type Post = Model<{ email: Optional<Email> }>

// Previously broken — extractor sees "Nullable", not "Optional"
type Nullable<T> = Optional<T>
type Post = Model<{ email: Nullable<Email> }>

// Previously broken — import rename
import { Optional as Maybe } from "@supatype/types"
type Post = Model<{ email: Maybe<Email> }>
```

Failures were silent — unknown types fell through to `{ kind: "text", pgType: "TEXT" }`
instead of throwing an error.

---

## Three-Tier Resolution

Every type name encountered in a field definition is resolved through three tiers
in order. The first tier to succeed wins. If all three fail, an error is thrown.

```
Tier 1 — syntactic switch      instant    inline primitives and modifiers by name
Tier 2 — alias registry        instant    user-defined type aliases, import renames
Tier 3 — TypeScript checker    ~300ms†    conditional types, mapped types
```

† Tier 3 is **lazy** — the `ts.Program` and `TypeChecker` are only created the first
time a conditional or mapped type is encountered. Schemas that use only tiers 1 and 2
pay no cost.

---

## Tier 1 — Syntactic Switch

The existing behaviour. The extractor walks the type reference chain and matches
names exactly against a hardcoded switch:

```typescript
switch (typeName) {
  case "Optional":    flags.required = false;  unwrap(); continue
  case "Unique":      flags.unique = true;     unwrap(); continue
  case "PrimaryKey":  flags.primaryKey = true; unwrap(); continue
  case "UUID":        return { kind: "uuid",  pgType: "UUID" }
  case "Email":       return { kind: "email", pgType: "TEXT" }
  // ... all @supatype/types primitives and modifiers
}
```

This covers all types used inline with their canonical names.

---

## Tier 2 — Alias Registry

Built once at startup from all source files loaded by `loadSchemaSourceFiles`.
Covers two sub-cases:

### 2a — Type alias declarations

Any `type X = ...` that is not a `Model<>` declaration is indexed by name:

```typescript
// These all become entries in the alias registry:
type Nullable<T>  = Optional<T>
type UniqueSlug   = Unique<Slug<"title">>
type AuditId      = PrimaryKey<UUID>
type MyEnum       = "draft" | "published" | "archived"
```

When the extractor encounters an unknown name, it looks it up in the registry,
substitutes any type parameters via text replacement, and re-enters tier 1 with
the resolved node.

Multi-hop aliases work because the resolution recurses:

```typescript
type A = B
type B = Optional<Email>
// A → B → Optional<Email> → resolved by tier 1
```

Cycle detection via a `resolving: Set<string>` guard prevents infinite loops and
throws a descriptive error instead.

### 2b — Import renames

Explicit `as` renames in import statements are indexed per file:

```typescript
import { Optional as Maybe } from "@supatype/types"
import { Nullable as MaybeNull } from "./shared/field-types"
```

Before the tier 1 switch runs, each name is checked against the rename map for
the current file. `Maybe` becomes `Optional`, `MaybeNull` becomes `Nullable`
(which is then resolved by 2a).

### File loading

`loadSchemaSourceFiles` follows both `export` declarations (existing) and local
`import` declarations (new), ensuring that files referenced via import are loaded
into the source file set and their aliases are available in the registry.

Only relative specifiers (`.`-prefixed) are followed. Bare specifiers and scoped
packages (`@supatype/types`, `node_modules/*`) are not loaded — their exported
names are already covered by the tier 1 switch.

---

## Tier 3 — TypeScript Checker

Required for types that cannot be evaluated syntactically:

- **Conditional types**: `T extends U ? A : B` — requires evaluating the constraint
- **Mapped types**: `{ [K in keyof T]: F<T[K]> }` — requires enumerating `keyof T`

### How it works

1. A lazy `ts.Program` is created from the already-loaded source files using a
   custom `CompilerHost` that serves them from memory (no disk re-reads).

2. Because our lightweight parse tree and the Program's parse tree are different
   objects (even for the same file), the node with the unresolvable type is located
   in the Program's source file by matching `pos`/`end` character positions.

3. `checker.getTypeAtLocation(programNode)` resolves the type fully.

4. `checker.typeToString(type, ..., TypeFormatFlags.UseAliasDefinedOutsideCurrentScope)`
   converts it back to a string with **alias names preserved** — so `Optional<Email>`
   stays as `Optional<Email>` rather than expanding to the underlying branded
   intersection type.

5. The string is re-parsed via `ts.createSourceFile` into a proper TypeNode with
   valid `pos`/`end` values (so downstream `getText()` calls work).

6. The resolved TypeNode is fed back into the tier 1 switch.

### When tier 3 fires

- A field type is directly a conditional or mapped expression
- A tier 2 alias body contains a conditional or mapped type (detected by
  `needsChecker()` before text substitution is attempted — the original node,
  which has valid source positions, is passed to the checker instead)
- The `Model<>` fields argument is a mapped type alias:
  ```typescript
  type AllOptional<T> = { [K in keyof T]: Optional<T[K]> }
  type Post = Model<AllOptional<{ email: Email; name: Text }>>
  ```
  This is handled in `unwrapModelFields`, which also participates in the
  three-tier chain.

---

## What Is Supported

```typescript
// Tier 1 — inline, canonical names
email:  Optional<Email>
slug:   Unique<Slug<"title">>
id:     PrimaryKey<UUID>

// Tier 2a — simple alias
type Nullable<T>  = Optional<T>
type UniqueSlug   = Unique<Slug<"title">>
email: Nullable<Email>
slug:  UniqueSlug

// Tier 2a — multi-hop
type A = B
type B = Nullable<Email>
email: A

// Tier 2b — import rename of primitive
import { Optional as Maybe } from "@supatype/types"
email: Maybe<Email>

// Tier 2b — import rename of local alias
import { Nullable as MaybeNull } from "./field-types"
email: MaybeNull<Email>

// Tier 2b — cross-file alias (no rename)
// helpers.ts: export type Nullable<T> = Optional<T>
import { Nullable } from "./helpers"
email: Nullable<Email>

// Tier 3 — conditional type
type NullableStr<T> = T extends string ? Optional<T> : T
email: NullableStr<Email>

// Tier 3 — mapped type as fields object
type AllOptional<T> = { [K in keyof T]: Optional<T[K]> }
type Post = Model<AllOptional<{ email: Email; name: Text }>>
```

---

## What Is Not Supported

```typescript
// Imports from node_modules other than @supatype/types
import { SomeHelper } from "some-library"

// Conditional / mapped types in alias bodies that reference
// symbols only available in node_modules (other than @supatype/types)

// TypeScript utility types used as field types
email: NonNullable<string>    // error — not a @supatype/types primitive

// Namespace-qualified names
email: Types.Optional<Email>  // error — only identifier references are resolved
```

---

## Error Behaviour

Unknown types now **throw** instead of silently falling back to
`{ kind: "text", pgType: "TEXT" }`:

```
Error: Unknown Supatype type "SomeType" in field "email".
If this is a type alias, confirm the file defining it is reachable
from your schema entry point.
```

Cycles in alias chains throw:

```
Error: Field "email": circular alias chain detected resolving "A".
```

Unresolvable conditional/mapped types throw:

```
Error: Field "email": could not resolve conditional/mapped type via type checker.
```

---

## Data Structures

```typescript
// One entry per non-Model type alias declaration across all loaded source files
type AliasEntry = {
  typeParams: string[]        // ["T"] for Nullable<T> = Optional<T>
  body:       ts.TypeNode     // the RHS of the declaration
  sourceFile: ts.SourceFile   // getText() context for body
}

// Rename map: sf.fileName → (localName → canonicalName)
// Only populated for explicit `import { X as Y }` renames
type ImportRenameMap = Map<string, Map<string, string>>

// Passed to every resolution function; checker is lazy
type ResolveContext = {
  aliasRegistry: Map<string, AliasEntry>
  renameMap:     ImportRenameMap
  getChecker:    () => CheckerContext
}

type CheckerContext = {
  program: ts.Program
  checker: ts.TypeChecker
}
```

---

## Adding a New Tier 1 Primitive

When a new type is added to `@supatype/types`, add a `case` to the `switch` in
`parseScalarType`. No other changes are needed — tier 2 and tier 3 handle
aliases and compositions of it automatically.
