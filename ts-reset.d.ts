// Three library signatures that hand back `any`, reset to hand back `unknown`.
//
// The style of @total-typescript/ts-reset (its `fetch`, `json-parse` and `is-array` entries), declared
// here rather than imported from the package. Its entries resolve only through `exports`, so under a
// tsconfig with `moduleResolution: "node"` the import resolves to nothing, silently, and the reset is
// lost with no error; a file of its own has no such failure, and no package to install in a Docker
// build or a project outside the workspace.
//
// Every tsconfig in this repository includes this file. A declaration here merges with the library's
// and, being declared later, is the overload that is tried first.
//
// With these, `await res.json()` and `JSON.parse(text)` are `unknown`, so a value read from outside is
// checked before it is used, and `as T` cannot launder it: `no-unsafe-type-assertion` refuses that.

interface Body {
  json(): Promise<unknown>;
}

interface JSON {
  parse(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown;
}

interface ArrayConstructor {
  isArray(arg: unknown): arg is unknown[];
}
