import React from "react"

type AnyProps = Record<string, unknown> & { children?: React.ReactNode }

function box(name: string) {
  return function Mock({ children, ...props }: AnyProps): React.ReactElement {
    return React.createElement(name, props, children)
  }
}

export const View = box("View")
export const Text = box("Text")
export const TextInput = box("TextInput")
export const Pressable = box("Pressable")
export const ScrollView = box("ScrollView")
export const KeyboardAvoidingView = box("KeyboardAvoidingView")
export const ActivityIndicator = box("ActivityIndicator")
export const Platform = { OS: "ios" as const }
export const StyleSheet = {
  create<T>(styles: T): T {
    return styles
  },
}
