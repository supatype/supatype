import type { WidgetProps } from "@supatype/plugin-sdk"

interface SeoValues {
  meta_title: string
  meta_description: string
  og_image: string
  canonical_url: string
  no_index: boolean
}

const TITLE_MAX = 60
const DESC_MAX = 160
const WARN_THRESHOLD = 0.9

function getCountStyle(current: number, max: number): React.CSSProperties {
  if (current > max) {
    return { color: "red", fontWeight: "bold" }
  }
  if (current >= Math.floor(max * WARN_THRESHOLD)) {
    return { color: "#b8860b" }
  }
  return { color: "inherit" }
}

export default function SeoWidget(props: WidgetProps<SeoValues>) {
  const { value, onChange, disabled, errors } = props

  const data: SeoValues = value ?? {
    meta_title: "",
    meta_description: "",
    og_image: "",
    canonical_url: "",
    no_index: false,
  }

  const update = (field: keyof SeoValues, fieldValue: string | boolean) => {
    onChange({ ...data, [field]: fieldValue })
  }

  const titleLen = data.meta_title.length
  const descLen = data.meta_description.length

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <div>
        <label>
          Meta Title{" "}
          <span style={getCountStyle(titleLen, TITLE_MAX)}>
            ({titleLen}/{TITLE_MAX})
          </span>
        </label>
        <input
          type="text"
          value={data.meta_title}
          onChange={(e) => update("meta_title", e.target.value)}
          disabled={disabled}
          maxLength={TITLE_MAX + 20}
          style={{ width: "100%" }}
        />
      </div>

      <div>
        <label>
          Meta Description{" "}
          <span style={getCountStyle(descLen, DESC_MAX)}>
            ({descLen}/{DESC_MAX})
          </span>
        </label>
        <textarea
          value={data.meta_description}
          onChange={(e) => update("meta_description", e.target.value)}
          disabled={disabled}
          rows={3}
          style={{ width: "100%" }}
        />
      </div>

      <div>
        <label>OG Image URL</label>
        <input
          type="text"
          value={data.og_image}
          onChange={(e) => update("og_image", e.target.value)}
          disabled={disabled}
          style={{ width: "100%" }}
        />
      </div>

      <div>
        <label>Canonical URL</label>
        <input
          type="text"
          value={data.canonical_url}
          onChange={(e) => update("canonical_url", e.target.value)}
          disabled={disabled}
          style={{ width: "100%" }}
        />
      </div>

      <div>
        <label>
          <input
            type="checkbox"
            checked={data.no_index}
            onChange={(e) => update("no_index", e.target.checked)}
            disabled={disabled}
          />{" "}
          No Index
        </label>
      </div>

      {errors.length > 0 && errors.map((err: string, i: number) => (
        <span key={i} style={{ color: "red", fontSize: "0.85em" }}>
          {err}
        </span>
      ))}
    </div>
  )
}
