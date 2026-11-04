# Changelog

## Unreleased

### Breaking Changes

* **rich-text:** `RichTextEditor` and `RichTextEditorProps` moved to `@supatype/ui/rich-text`.
  Importing them from `@supatype/ui` fails; change the import to
  `import { RichTextEditor } from "@supatype/ui/rich-text"`. The main entry no longer loads Lexical,
  so an app that never renders the editor no longer needs the Lexical packages, which are now
  optional peer dependencies. The rich text helpers (`emptyRichTextDocument`, `richTextIsEmpty`,
  `stringToRichTextDocument`, `normalizeRichTextDefault`) and the `SerializedEditorState` types stay
  in `@supatype/ui`.

### Bug Fixes

* **styles:** `@supatype/ui/styles.css` exists. The package exported it, but no build produced it,
  so the import failed and the editor rendered unstyled unless an app copied the rules in by hand.
  Import it once, before your own CSS, and theme the editor with the `--su-rt-*` custom properties
  listed in the README.
* **rich-text:** text that is both underlined and struck through shows both lines. It showed only
  the strikethrough.
* **rich-text:** headings and lists in the editor are styled. Headings had no rule for the classes
  the editor puts on them, and lists lost their markers under Tailwind's reset.
* **rich-text:** `editable` takes effect when it changes, not only on mount. Changing it swapped
  the toolbar but left the content as editable, or as locked, as it started.
* **rich-text:** quotes are styled. A pasted blockquote rendered with no rule of the package's,
  and now sits behind a left border in the muted colour, from the `--su-rt-*` variables.
* **package:** the tarball ships `dist`, the README, the changelog and the license only, with no
  source or declaration maps, and drops six Radix UI dependencies no component used.
* **input:** an `Input` with no `id` gets a unique one from `React.useId()`. It used the label as
  a slug (`"Email address"` became `email-address`), so two inputs with the same label shared an
  id and the second label focused the first input. If your code or tests find an input by that
  slug, pass `id` explicitly. With an `error`, the input now sets `aria-invalid` and points
  `aria-describedby` at the error text (id `<input id>-error`), keeping any `aria-describedby` you
  pass.

### Documentation

* **readme:** a README covering install, the Tailwind setup the components need (v4 `@source`, v3
  `content`, class-based dark mode for `ThemeProvider`), the stylesheet, the exports and the
  rich-text entry.
