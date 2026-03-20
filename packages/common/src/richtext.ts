/**
 * Rich text rendering — converts Lexical JSON to HTML.
 */

export type RichTextNode =
  | { type: "heading"; tag: "h2" | "h3" | "h4"; children: RichTextNode[] }
  | { type: "paragraph"; children: RichTextNode[] }
  | { type: "text"; text: string; format?: { bold?: boolean; italic?: boolean; code?: boolean } }
  | { type: "link"; url: string; children: RichTextNode[] }
  | { type: "code"; language: string; code: string }
  | { type: "image"; src: string; alt: string; width?: number; height?: number }
  | { type: "blockquote"; children: RichTextNode[] }
  | { type: "list"; listType: "ordered" | "unordered"; children: RichTextNode[] }
  | { type: "listitem"; children: RichTextNode[] }
  | { type: "horizontalrule" }
  | { type: "root"; children: RichTextNode[] }
  | { type: "callout"; variant: "tip" | "warning" | "danger"; children: RichTextNode[] }
  | { type: "code-tabs"; tabs: Array<{ label: string; language: string; code: string }> }
  | { type: "cta"; text: string; url: string }
  | { type: "embed"; provider: "youtube" | "codesandbox"; embedId: string }

const CALLOUT_ICONS: Record<"tip" | "warning" | "danger", string> = {
  tip: "\u{1F4A1}",
  warning: "\u26A0\uFE0F",
  danger: "\u{1F6AB}",
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function renderChildren(children: RichTextNode[]): string {
  return children.map(renderRichText).join("")
}

/**
 * Convert a Lexical JSON node tree into an HTML string.
 */
export function renderRichText(node: RichTextNode): string {
  switch (node.type) {
    case "root":
      return renderChildren(node.children)

    case "heading":
      return `<${node.tag}>${renderChildren(node.children)}</${node.tag}>`

    case "paragraph":
      return `<p>${renderChildren(node.children)}</p>`

    case "text": {
      let html = escapeHtml(node.text)
      if (node.format?.code) html = `<code>${html}</code>`
      if (node.format?.bold) html = `<strong>${html}</strong>`
      if (node.format?.italic) html = `<em>${html}</em>`
      return html
    }

    case "link":
      return `<a href="${escapeHtml(node.url)}">${renderChildren(node.children)}</a>`

    case "code":
      return `<pre><code class="language-${escapeHtml(node.language)}">${escapeHtml(node.code)}</code></pre>`

    case "image": {
      const attrs = [
        `src="${escapeHtml(node.src)}"`,
        `alt="${escapeHtml(node.alt)}"`,
        ...(node.width !== undefined ? [`width="${node.width}"`] : []),
        ...(node.height !== undefined ? [`height="${node.height}"`] : []),
      ]
      return `<img ${attrs.join(" ")} />`
    }

    case "blockquote":
      return `<blockquote>${renderChildren(node.children)}</blockquote>`

    case "list": {
      const tag = node.listType === "ordered" ? "ol" : "ul"
      return `<${tag}>${renderChildren(node.children)}</${tag}>`
    }

    case "listitem":
      return `<li>${renderChildren(node.children)}</li>`

    case "horizontalrule":
      return `<hr />`

    case "callout":
      return `<div class="callout callout-${node.variant}">${CALLOUT_ICONS[node.variant]} ${renderChildren(node.children)}</div>`

    case "code-tabs": {
      const buttons = node.tabs
        .map(
          (tab, i) =>
            `<button class="code-tab-button${i === 0 ? " active" : ""}" data-tab="${i}">${escapeHtml(tab.label)}</button>`,
        )
        .join("")
      const panels = node.tabs
        .map(
          (tab, i) =>
            `<div class="code-tab-panel${i === 0 ? " active" : ""}" data-tab="${i}"><pre><code class="language-${escapeHtml(tab.language)}">${escapeHtml(tab.code)}</code></pre></div>`,
        )
        .join("")
      return `<div class="code-tabs"><div class="code-tabs-buttons">${buttons}</div>${panels}</div>`
    }

    case "cta":
      return `<a class="cta-button" href="${escapeHtml(node.url)}">${escapeHtml(node.text)}</a>`

    case "embed": {
      if (node.provider === "youtube") {
        return `<iframe src="https://www.youtube-nocookie.com/embed/${escapeHtml(node.embedId)}" frameborder="0" allowfullscreen loading="lazy"></iframe>`
      }
      return `<iframe src="https://codesandbox.io/embed/${escapeHtml(node.embedId)}" frameborder="0" allow="accelerometer; ambient-light-sensor; camera; encrypted-media; geolocation; gyroscope; hid; microphone; midi; payment; usb; vr; xr-spatial-tracking" sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts" loading="lazy"></iframe>`
    }

    default: {
      const _exhaustive: never = node
      return ""
    }
  }
}
