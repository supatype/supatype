// @supatype/ui: Shared component library

export { Button } from "./Button.js"
export type { ButtonProps } from "./Button.js"

export { Input } from "./Input.js"
export type { InputProps } from "./Input.js"

export { Card } from "./Card.js"
export type { CardProps } from "./Card.js"

export { Badge } from "./Badge.js"
export type { BadgeProps } from "./Badge.js"

export { Skeleton } from "./Skeleton.js"

export { ThemeProvider, useTheme } from "./ThemeProvider.js"

// RichTextEditor lives at "@supatype/ui/rich-text" so this entry never imports lexical.
// The helpers below only touch the serialized JSON shape, so they stay here.
export { emptyRichTextDocument, normalizeRichTextDefault, richTextIsEmpty, stringToRichTextDocument } from "./richtext-utils.js"
export type { SerializedEditorState, SerializedLexicalNode } from "@supatype/types/lexical"
