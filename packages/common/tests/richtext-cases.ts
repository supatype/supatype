import { readFileSync } from "node:fs"
import type { SerializedEditorState } from "@supatype/types/lexical"

/**
 * Saved Lexical documents and the HTML each must render to. Shared by the string renderer's tests
 * here and the React component's tests, so both renderers are held to the same output.
 *
 * `lexical-documents.json` is written by Lexical 0.43 itself with Studio's editor node set
 * (packages/studio/tests/lexical-fixtures.test.ts rebuilds it and fails on drift).
 * `lexical-code-block.json` was written the same way with `@lexical/code-core`'s CodeNode, which
 * the editors do not register but pasted or imported content can carry. `kitchenSinkAbstract` is
 * copied verbatim from a talk row in a running kitchen-sink database.
 */

type Documents = Record<string, SerializedEditorState>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * A saved document: an object whose `root` has a list of children. A boundary: the fixtures were
 * written by Lexical itself, so the nodes under the root are taken as Lexical wrote them.
 */
function isEditorState(value: unknown): value is SerializedEditorState {
  return isObject(value) && isObject(value["root"]) && Array.isArray(value["root"]["children"])
}

function asEditorState(value: unknown, name: string): SerializedEditorState {
  if (!isEditorState(value)) throw new Error(`${name} is not a saved Lexical document`)
  return value
}

function load(name: string): Documents {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))
  if (!isObject(raw)) throw new Error(`${name} is not a map of documents`)
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, asEditorState(value, key)]))
}

const documents: Documents = { ...load("lexical-documents.json"), ...load("lexical-code-block.json") }

function doc(name: string): SerializedEditorState {
  const found = documents[name]
  if (found === undefined) throw new Error(`no fixture named ${name}`)
  return found
}

const kitchenSinkAbstract = asEditorState(JSON.parse(
  '{"root": {"type": "root", "format": "", "indent": 0, "version": 1, "children": [{"type": "paragraph", "format": "", "indent": 0, "version": 1, "children": [{"mode": "normal", "text": "A talk in the main hall, and the abstract an editor would have written.", "type": "text", "style": "", "detail": 0, "format": 0, "version": 1}], "direction": "ltr"}], "direction": "ltr"}}',
), "kitchenSinkAbstract")

export interface RenderCase {
  name: string
  content: SerializedEditorState
  html: string
}

const TRANSFORM = (value: string): string => `<span style="text-transform:${value}">${value}</span>`

export const RENDER_CASES: RenderCase[] = [
  {
    name: "every single format bit",
    content: doc("formats"),
    html:
      "<p><strong>bold</strong><em>italic</em><s>strikethrough</s><u>underline</u><code>code</code>" +
      "<sub>subscript</sub><sup>superscript</sup><mark>highlight</mark>" +
      `${TRANSFORM("lowercase")}${TRANSFORM("uppercase")}${TRANSFORM("capitalize")}</p>`,
  },
  {
    name: "format bits combined",
    content: doc("formatCombinations"),
    html:
      "<p><strong><em>bold italic</em></strong><strong><code>bold code</code></strong>" +
      "<s><u>underline strikethrough</u></s>" +
      "<strong><em><s><u><mark><code>everything</code></mark></u></s></em></strong>" +
      "<sup>sub and sup</sup></p>",
  },
  {
    name: "headings h1 to h6",
    content: doc("headings"),
    html: [1, 2, 3, 4, 5, 6].map((n) => `<h${n}>Heading h${n}</h${n}>`).join(""),
  },
  {
    name: "alignment and indent",
    content: doc("blockAttributes"),
    html:
      ["left", "center", "right", "justify", "start", "end"]
        .map((a) => `<p style="text-align:${a}">${a}</p>`)
        .join("") + '<p style="padding-inline-start:calc(2 * 40px)">indented twice</p>',
  },
  {
    name: "quote",
    content: doc("quote"),
    html: "<blockquote>Quoted <em>words</em></blockquote>",
  },
  {
    name: "bullet, numbered and check lists",
    content: doc("lists"),
    html:
      "<ul><li>apple</li><li><strong>pear</strong></li></ul>" +
      '<ol start="3"><li value="3">first</li><li value="4">second</li></ol>' +
      '<ul><li><input type="checkbox" checked disabled />done</li>' +
      '<li><input type="checkbox" disabled />todo</li></ul>',
  },
  {
    name: "nested list keeps the outer numbering",
    content: doc("nestedList"),
    html:
      '<ol><li value="1">outer one</li>' +
      '<li style="list-style-type:none"><ul><li>inner one</li><li>inner two</li></ul></li>' +
      '<li value="2">outer two</li></ol>',
  },
  {
    name: "links and autolinks",
    content: doc("links"),
    html:
      '<p><a href="https://example.com/a?b=1&amp;c=2">plain</a></p>' +
      '<p><a href="https://example.com" rel="noreferrer noopener" target="_blank" title="A &quot;title&quot;">new tab</a></p>' +
      '<p><a href="/relative/path">relative</a></p>' +
      '<p><a href="mailto:someone@example.com">mail</a></p>' +
      '<p><a href="https://auto.example.com">https://auto.example.com</a></p>' +
      "<p>unlinked</p>",
  },
  {
    name: "line breaks and tabs",
    content: doc("breaks"),
    html: "<p>line one<br />line two\tafter tab</p>",
  },
  {
    name: "horizontal rule",
    content: doc("horizontalRule"),
    html: "<p>above</p><hr /><p>below</p>",
  },
  {
    name: "code blocks",
    content: doc("codeBlock"),
    html:
      '<pre><code class="language-typescript">const a = &quot;&lt;b&gt;&amp;&quot;\n\treturn a</code></pre>' +
      "<pre><code>x &lt; y</code></pre>",
  },
  {
    name: "a record saved by the engine",
    content: kitchenSinkAbstract,
    html: '<p dir="ltr">A talk in the main hall, and the abstract an editor would have written.</p>',
  },
  {
    name: "script in text and unsafe link targets",
    content: doc("xss"),
    html:
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;</p>" +
      "<p>js</p><p>js mixed case</p><p>js with tab</p><p>data url</p><p>vbscript</p>" +
      '<p><a href="https://example.com/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">attribute breakout</a></p>',
  },
]
