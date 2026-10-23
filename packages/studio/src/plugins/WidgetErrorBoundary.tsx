import { Component, type ReactNode } from "react"
import { Button, Input } from "../components/ui.js"

// -- Props -------------------------------------------------------------------

export interface WidgetErrorBoundaryProps {
  widgetName: string
  fieldName: string
  value: unknown
  onChange: (v: unknown) => void
  children: ReactNode
}

// -- State -------------------------------------------------------------------

interface WidgetErrorBoundaryState {
  hasError: boolean
  error: Error | null
  retryKey: number
}

// -- Component ---------------------------------------------------------------

/**
 * Error boundary that wraps plugin widgets. When a widget crashes, it shows
 * a fallback message and a plain text input with the current value. A "Retry"
 * button re-mounts the widget by toggling a key.
 */
export class WidgetErrorBoundary extends Component<
  WidgetErrorBoundaryProps,
  WidgetErrorBoundaryState
> {
  constructor(props: WidgetErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null, retryKey: 0 }
  }

  static getDerivedStateFromError(error: Error): Partial<WidgetErrorBoundaryState> {
    return { hasError: true, error }
  }

  private handleRetry = (): void => {
    this.setState((prev) => ({
      hasError: false,
      error: null,
      retryKey: prev.retryKey + 1,
    }))
  }

  private handleFallbackChange = (
    e: React.ChangeEvent<HTMLInputElement>,
  ): void => {
    this.props.onChange(e.target.value)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div role="alert" className="space-y-2 rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive-text">
            Plugin widget &apos;{this.props.widgetName}&apos; crashed, so this shows the default input.
          </p>

          <Input
            type="text"
            value={typeof this.props.value === "string" ? this.props.value : String(this.props.value ?? "")}
            onChange={this.handleFallbackChange}
            aria-label={this.props.fieldName}
          />

          <Button type="button" size="xs" onClick={this.handleRetry}>
            Retry
          </Button>
        </div>
      )
    }

    // Key changes on retry so React unmounts/remounts children.
    return <div key={this.state.retryKey}>{this.props.children}</div>
  }
}
