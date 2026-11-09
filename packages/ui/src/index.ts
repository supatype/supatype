// @supatype/ui: Shared component library

export { Button } from "./Button.js"
export type { ButtonProps } from "./Button.js"

export { Input } from "./Input.js"
export type { InputProps } from "./Input.js"

export { Select } from "./Select.js"
export type { SelectProps } from "./Select.js"

export { Textarea } from "./Textarea.js"
export type { TextareaProps } from "./Textarea.js"

export { Checkbox } from "./Checkbox.js"
export type { CheckboxProps } from "./Checkbox.js"

export { Table, THead, TBody, Tr, Th, Td } from "./Table.js"
export type { TableProps, TableSectionProps, TrProps, ThProps, TdProps } from "./Table.js"

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
