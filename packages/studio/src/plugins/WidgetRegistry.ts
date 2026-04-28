// -- Types -------------------------------------------------------------------

export interface WidgetEntry {
  /** Unique widget name */
  name: string
  /** Human-readable label */
  label: string
  /** Field types this widget is compatible with */
  compatibleTypes: string[]
  /** Path to the React component (relative to the plugin package) */
  componentPath: string
  /** npm package name of the owning plugin */
  pluginName: string
}

export interface WidgetRegistration {
  label: string
  compatibleTypes: string[]
  componentPath: string
  pluginName: string
}

// -- Registry ----------------------------------------------------------------

const widgets = new Map<string, WidgetEntry>()

/**
 * Register a widget in the global registry.
 *
 * @param name - Unique widget name (e.g. "color-picker")
 * @param definition - Widget metadata including component path and compatible types
 */
export function registerWidget(
  name: string,
  definition: WidgetRegistration,
): void {
  widgets.set(name, {
    name,
    label: definition.label,
    compatibleTypes: definition.compatibleTypes,
    componentPath: definition.componentPath,
    pluginName: definition.pluginName,
  })
}

/**
 * Get all widgets compatible with a given field type.
 */
export function getWidgetsForType(fieldType: string): WidgetEntry[] {
  const results: WidgetEntry[] = []
  for (const entry of widgets.values()) {
    if (entry.compatibleTypes.includes(fieldType)) {
      results.push(entry)
    }
  }
  return results
}

/**
 * Look up a single widget by name.
 */
export function getWidget(name: string): WidgetEntry | undefined {
  return widgets.get(name)
}
