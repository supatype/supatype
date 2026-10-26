import { lazy, Suspense, useMemo } from "react"
import { isJsonObject } from "../lib/json.js"
import { WidgetErrorBoundary } from "./WidgetErrorBoundary.js"

// -- Props -------------------------------------------------------------------

export interface WidgetLoaderProps {
  pluginName: string
  componentPath: string
  value: unknown
  onChange: (v: unknown) => void
  fieldName: string
  fieldType: string
  config: Record<string, unknown>
  errors: string[]
  disabled?: boolean | undefined
}

// -- Widget component cache --------------------------------------------------

type PluginWidget = React.ComponentType<Record<string, unknown>>

const componentCache = new Map<string, React.LazyExoticComponent<PluginWidget>>()

/**
 * Whether a module's default export is something React can render: a function or class component,
 * or the object `memo` and `forwardRef` return.
 *
 * The boundary for plugin widgets. A plugin is code loaded by name at runtime, so the props it
 * expects cannot be checked here; what can be checked is that React will accept it at all, and a
 * module that fails that is reported by the error boundary rather than rendered.
 */
function isPluginWidget(value: unknown): value is PluginWidget {
  if (typeof value === "function") return true
  return isJsonObject(value) && "$$typeof" in value
}

async function importWidget(pluginName: string, componentPath: string): Promise<{ default: PluginWidget }> {
  const mod: unknown = await import(/* @vite-ignore */ `${pluginName}/${componentPath}`)
  const component = isJsonObject(mod) ? mod["default"] : undefined
  if (!isPluginWidget(component)) {
    throw new Error(`${pluginName}/${componentPath} has no default export that renders as a component`)
  }
  return { default: component }
}

function getLazyComponent(pluginName: string, componentPath: string): React.LazyExoticComponent<PluginWidget> {
  const cacheKey = `${pluginName}::${componentPath}`

  const cached = componentCache.get(cacheKey)
  if (cached) return cached

  const LazyComponent = lazy(() => importWidget(pluginName, componentPath))
  componentCache.set(cacheKey, LazyComponent)
  return LazyComponent
}

// -- Spinner -----------------------------------------------------------------

function LoadingSpinner(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-label="Loading widget"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: 8,
        color: "#888",
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        style={{ animation: "spin 1s linear infinite" }}
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="28"
          strokeDashoffset="8"
          strokeLinecap="round"
        />
      </svg>
      <span>Loading widget...</span>
    </div>
  )
}

// -- Component ---------------------------------------------------------------

/**
 * Dynamically imports and renders a plugin widget component. Uses
 * `React.lazy` + `Suspense` for async loading and wraps the widget in
 * an error boundary so a crashing plugin cannot take down the page.
 */
export function WidgetLoader(props: WidgetLoaderProps): React.JSX.Element {
  const {
    pluginName,
    componentPath,
    value,
    onChange,
    fieldName,
    fieldType,
    config,
    errors,
    ...rest
  } = props

  const LazyWidget = useMemo(
    () => getLazyComponent(pluginName, componentPath),
    [pluginName, componentPath],
  )

  return (
    <WidgetErrorBoundary
      widgetName={pluginName}
      fieldName={fieldName}
      value={value}
      onChange={onChange}
    >
      <Suspense fallback={<LoadingSpinner />}>
        <LazyWidget
          value={value}
          onChange={onChange}
          fieldName={fieldName}
          fieldType={fieldType}
          config={config}
          errors={errors}
          {...(rest.disabled !== undefined ? { disabled: rest.disabled } : {})}
        />
      </Suspense>
    </WidgetErrorBoundary>
  )
}
