// @supatype/ui/rich-text: the Lexical-backed editor. A separate entry so the main entry never
// pulls in lexical; only apps that render this editor need the optional lexical peers installed.

export { RichTextEditor } from "./RichTextEditor.js"
export type { RichTextEditorProps } from "./RichTextEditor.js"
