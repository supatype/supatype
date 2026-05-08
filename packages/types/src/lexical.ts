export interface SerializedLexicalNode {
  type: string
  version: number
  children?: SerializedLexicalNode[]
  [key: string]: unknown
}

export interface SerializedEditorState {
  root: SerializedLexicalNode
}
