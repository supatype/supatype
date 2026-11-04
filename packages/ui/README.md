# `@supatype/ui`

React components for Supatype apps: `Button`, `Input`, `Card`, `Badge`, `Skeleton`, a
`ThemeProvider`, and a Lexical rich text editor that reads and writes the `RichText` JSON a
Supatype schema stores.

## Install

```bash
npm install @supatype/ui
```

React 18 or 19 is a peer dependency. The rich text editor also needs Lexical; install it only if
you use the editor (see [Rich text editor](#rich-text-editor)).

## Styling: Tailwind is required

`Button`, `Input`, `Card`, `Badge` and `Skeleton` are styled with Tailwind utility classes from
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
| `Card`, `CardProps` | bordered container with `padding` (`sm`, `md`, `lg`) |
| `Badge`, `BadgeProps` | pill label with `variant` (`default`, `success`, `warning`, `danger`, `purple`) |
| `Skeleton` | pulsing loading placeholder |
| `ThemeProvider`, `useTheme` | light, dark or system theme, saved in `localStorage` |
| `emptyRichTextDocument` | an empty rich text document (one empty paragraph) |
| `stringToRichTextDocument` | plain text to a rich text document |
| `normalizeRichTextDefault` | turns a stored default (document, JSON string or plain string) into a document, or `null` |
| `richTextIsEmpty` | true when a document has no text |
| `SerializedEditorState`, `SerializedLexicalNode` | the rich text JSON types |

None of these import Lexical.

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
