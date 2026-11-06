# `@supatype/ui`

React components for Supatype apps: `Button`, the form controls `Input`, `Select`, `Textarea` and
`Checkbox`, `Card`, `Badge`, `Table`, `Skeleton`, a `ThemeProvider`, and a Lexical rich text editor
that reads and writes the `RichText` JSON a Supatype schema stores.

## Install

```bash
npm install @supatype/ui
```

React 18 or 19 is a peer dependency. The rich text editor also needs Lexical; install it only if
you use the editor (see [Rich text editor](#rich-text-editor)).

## Styling: Tailwind is required

Every component except the rich text editor is styled with Tailwind utility classes from
the default palette (`bg-purple-600`, `text-neutral-700`, `dark:bg-neutral-900` and so on). The
package ships those class names in its JavaScript, not as compiled CSS, so your app's Tailwind
build has to see them. Without that step the components render unstyled.

### Tailwind v4

Tailwind v4 does not scan `node_modules`, so register the package with `@source` in the CSS file
that imports Tailwind:

```css
/* app/globals.css */
@import "tailwindcss";
@source "../node_modules/@supatype/ui/dist";
```

The `@source` path is resolved relative to the CSS file it appears in, not to the project root.
From `app/globals.css` the `node_modules` folder is one level up, hence `../`; from
`src/styles/index.css` it would be `../../node_modules/@supatype/ui/dist`. In a monorepo, point it
at whichever `node_modules` actually holds the package.

### Tailwind v3

Add the package to `content` in `tailwind.config.js`:

```js
export default {
  content: [
    "./src/**/*.{ts,tsx}",
    "./node_modules/@supatype/ui/dist/**/*.js",
  ],
}
```

### Dark mode

`ThemeProvider` switches themes by toggling a `dark` class on `<html>`. Tailwind's `dark:` variant
has to follow that class rather than the operating system setting:

- v4: add `@custom-variant dark (&:where(.dark, .dark *));` after `@import "tailwindcss";`
- v3: set `darkMode: "class"` in `tailwind.config.js`

## Stylesheet

Import the package stylesheet once, before your own CSS, so your rules can override it:

```ts
import "@supatype/ui/styles.css"
```

or, from CSS:

```css
@import "@supatype/ui/styles.css";
```

It holds the rich text editor's styles. The editor is themed with CSS custom properties, which you
can set on `:root` or on any ancestor of the editor:

| Property | Default | Used for |
|---|---|---|
| `--su-rt-border` | `#e5e7eb` | toolbar, surface and button borders |
| `--su-rt-border-width` | `1px` | toolbar and surface border width |
| `--su-rt-radius` | `6px` | corner radius (buttons use two thirds of it) |
| `--su-rt-bg` | `#ffffff` | editing surface |
| `--su-rt-toolbar-bg` | `#f9fafb` | toolbar strip |
| `--su-rt-button-bg` | `--su-rt-bg` | toolbar buttons |
| `--su-rt-fg` | inherited | toolbar button text |
| `--su-rt-muted` | `#6b7280` | placeholder text |
| `--su-rt-accent` | `#2563eb` | links and toolbar button hover |
| `--su-rt-min-height` | `8rem` | editing surface height |
| `--su-rt-pad-y`, `--su-rt-pad-x` | `0.75rem`, `1rem` | editing surface padding |

## Exports

From `@supatype/ui`:

| Export | What it is |
|---|---|
| `Button`, `ButtonProps` | button with `variant` (`primary`, `secondary`, `ghost`, `danger`) and `size` (`sm`, `md`, `lg`) |
| `Input`, `InputProps` | text input with optional `label` and `error` |
| `Select`, `SelectProps` | native `<select>` with optional `label` and `error`; pass `<option>` children |
| `Textarea`, `TextareaProps` | multi-line text input with optional `label` and `error` |
| `Checkbox`, `CheckboxProps` | native checkbox with its `label` beside it and optional `error` |
| `Card`, `CardProps` | bordered container with `padding` (`sm`, `md`, `lg`) |
| `Badge`, `BadgeProps` | pill label with `variant` (`default`, `success`, `warning`, `danger`, `purple`) |
| `Table`, `THead`, `TBody`, `Tr`, `Th`, `Td` | styled native table parts; props `TableProps`, `TableSectionProps`, `TrProps`, `ThProps`, `TdProps` |
| `Skeleton` | pulsing loading placeholder |
| `ThemeProvider`, `useTheme` | light, dark or system theme, saved in `localStorage` |
| `emptyRichTextDocument` | an empty rich text document (one empty paragraph) |
| `stringToRichTextDocument` | plain text to a rich text document |
| `normalizeRichTextDefault` | turns a stored default (document, JSON string or plain string) into a document, or `null` |
| `richTextIsEmpty` | true when a document has no text |
| `SerializedEditorState`, `SerializedLexicalNode` | the rich text JSON types |

None of these import Lexical.

## Form controls

`Input`, `Select`, `Textarea` and `Checkbox` wrap the native element, forward their ref to it and
accept all of its props, so they work with `value`/`onChange`, `defaultValue`, `name` and form
libraries that register through a ref. Each takes an optional `label` and `error`:

- With no `id`, the control gets a unique one from `React.useId()`, and the label points at it.
  Pass `id` to choose your own.
- With an `error`, the control sets `aria-invalid` and adds the error text's id
  (`<control id>-error`) to `aria-describedby`, keeping any `aria-describedby` you pass.

```tsx
import { Checkbox, Input, Select, Textarea } from "@supatype/ui"

<Input label="Email" type="email" name="email" error={errors.email} />

<Select label="Role" name="role" defaultValue="member">
  <option value="member">Member</option>
  <option value="admin">Admin</option>
</Select>

<Textarea label="Bio" name="bio" rows={4} />

<Checkbox label="Send me product updates" name="updates" defaultChecked />
```

`Select` is the browser's own `<select>`, so it keeps native keyboard handling, mobile pickers and
form submission. `Checkbox` puts its label to the right of the box; clicking either toggles it.

## Table

`Table`, `THead`, `TBody`, `Tr`, `Th` and `Td` render `<table>`, `<thead>`, `<tbody>`, `<tr>`,
`<th>` and `<td>` with the package's borders and type scale, and accept each element's own props.
They fetch, sort and page nothing: map your rows into them.

```tsx
import { Table, TBody, Td, Th, THead, Tr } from "@supatype/ui"

<Table aria-label="Users">
  <THead>
    <Tr>
      <Th scope="col">Name</Th>
      <Th scope="col">Email</Th>
    </Tr>
  </THead>
  <TBody>
    {users.map((user) => (
      <Tr key={user.id}>
        <Td>{user.name}</Td>
        <Td>{user.email}</Td>
      </Tr>
    ))}
  </TBody>
</Table>
```

## Rich text editor

`RichTextEditor` has its own entry point so that apps which never use it do not need Lexical:

```bash
npm install lexical @lexical/react @lexical/rich-text @lexical/list @lexical/link @lexical/selection
```

```tsx
import { useState } from "react"
import "@supatype/ui/styles.css"
import { RichTextEditor } from "@supatype/ui/rich-text"
import { emptyRichTextDocument, type SerializedEditorState } from "@supatype/ui"

function BodyField(): React.ReactElement {
  const [body, setBody] = useState<SerializedEditorState>(emptyRichTextDocument())
  return <RichTextEditor value={body} onChange={setBody} placeholder="Write your post" />
}
```

`value` is read once, on mount. To load a different document into a mounted editor, change
`documentKey`. Pass `editable={false}` to render a document read only, with no toolbar; `editable`
can change at any time.

The Lexical packages are optional peer dependencies: your package manager will not install or warn
about them, and importing `@supatype/ui/rich-text` without them fails at build time.
