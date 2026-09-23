declare module "react-native" {
  import type * as React from "react"

  export type StyleProp<T> =
    | T
    | Array<T | StyleProp<T> | null | undefined | false>
    | null
    | undefined
    | false

  export interface ViewStyle {
    flex?: number | undefined
    padding?: number | undefined
    paddingVertical?: number | undefined
    paddingHorizontal?: number | undefined
    marginBottom?: number | undefined
    marginTop?: number | undefined
    gap?: number | undefined
    borderWidth?: number | undefined
    borderColor?: string | undefined
    borderRadius?: number | undefined
    backgroundColor?: string | undefined
    alignItems?: "flex-start" | "flex-end" | "center" | "stretch" | undefined
    justifyContent?: "flex-start" | "flex-end" | "center" | "space-between" | undefined
    opacity?: number | undefined
    width?: number | string | undefined
    minHeight?: number | undefined
    flexDirection?: "row" | "column" | undefined
  }
  export interface TextStyle {
    color?: string | undefined
    fontSize?: number | undefined
    fontWeight?: "400" | "500" | "600" | "700" | "normal" | "bold" | undefined
    marginBottom?: number | undefined
    textAlign?: "auto" | "left" | "right" | "center" | undefined
  }

  export interface ViewProps {
    style?: StyleProp<ViewStyle> | undefined
    children?: React.ReactNode | undefined
    accessibilityRole?: string | undefined
    accessibilityLiveRegion?: "none" | "polite" | "assertive" | undefined
    testID?: string | undefined
  }
  export interface TextProps {
    style?: StyleProp<TextStyle> | undefined
    children?: React.ReactNode | undefined
    accessibilityRole?: string | undefined
    accessibilityLiveRegion?: "none" | "polite" | "assertive" | undefined
  }
  export interface TextInputProps {
    style?: StyleProp<TextStyle | ViewStyle> | undefined
    value?: string | undefined
    onChangeText?: ((text: string) => void) | undefined
    placeholder?: string | undefined
    placeholderTextColor?: string | undefined
    secureTextEntry?: boolean | undefined
    autoCapitalize?: "none" | "sentences" | "words" | "characters" | undefined
    autoComplete?: string | undefined
    keyboardType?: "default" | "email-address" | "numeric" | undefined
    textContentType?: string | undefined
    editable?: boolean | undefined
    accessibilityLabel?: string | undefined
    testID?: string | undefined
  }
  export interface PressableProps {
    style?: StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>) | undefined
    onPress?: (() => void) | undefined
    disabled?: boolean | undefined
    accessibilityRole?: string | undefined
    accessibilityLabel?: string | undefined
    accessibilityState?: { disabled?: boolean | undefined } | undefined
    children?: React.ReactNode | undefined
    testID?: string | undefined
  }
  export interface ScrollViewProps {
    style?: StyleProp<ViewStyle> | undefined
    contentContainerStyle?: StyleProp<ViewStyle> | undefined
    keyboardShouldPersistTaps?: "always" | "never" | "handled" | undefined
    children?: React.ReactNode | undefined
  }
  export interface KeyboardAvoidingViewProps {
    style?: StyleProp<ViewStyle> | undefined
    behavior?: "height" | "position" | "padding" | undefined
    children?: React.ReactNode | undefined
  }
  export interface ActivityIndicatorProps {
    color?: string | undefined
    testID?: string | undefined
  }

  export const View: React.ComponentType<ViewProps>
  export const Text: React.ComponentType<TextProps>
  export const TextInput: React.ComponentType<TextInputProps>
  export const Pressable: React.ComponentType<PressableProps>
  export const ScrollView: React.ComponentType<ScrollViewProps>
  export const KeyboardAvoidingView: React.ComponentType<KeyboardAvoidingViewProps>
  export const ActivityIndicator: React.ComponentType<ActivityIndicatorProps>
  export const Platform: { OS: "ios" | "android" | "web" | "windows" | "macos" }
  export const StyleSheet: {
    create<T extends Record<string, ViewStyle | TextStyle>>(styles: T): T
  }
}
