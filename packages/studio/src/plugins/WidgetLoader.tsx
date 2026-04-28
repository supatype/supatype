import { lazy, Suspense, useMemo } from "react"
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

const componentCache = new Map<string, React.LazyExoticComponent<React.ComponentType<Record<string, unknown>>>>()

function getLazyComponent(
  pluginName: string,
  componentPath: string,
): React.LazyExoticComponent<React.ComponentType<Record<string, unknown>>> {
  const cacheKey = `${pluginName}::${componentPath}`

  const cached = componentCache.get(cacheKey)
  if (cached) return cached

  const LazyComponent = lazy(
    () => import(/* @vite-ignore */ `${pluginName}/${componentPath}`) as Promise<{
      default: React.ComponentType<Record<string, unknown>>
    }>,
  ) as React.LazyExoticComponent<React.ComponentType<Record<string, unknown>>>

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
