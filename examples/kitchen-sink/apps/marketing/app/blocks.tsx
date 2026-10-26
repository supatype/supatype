import React from "react"

/**
 * The block vocabulary, rendered.
 *
 * `Page.body` is `Blocks<HeroBlock | ProseBlock | SpeakerGridBlock>`, a closed set an editor
 * arranges, not a rich-text column with pasted HTML in it. The payoff is here: each block has a
 * known shape, so rendering is a switch rather than sanitising someone's markup.
 *
 * The rows arrive as `Json[]`, because a block list is JSONB in Postgres. Narrowing happens once,
 * at this boundary, so the components below take real types.
 */
type Block = Record<string, unknown>

function isBlock(value: unknown): value is Block {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function Blocks({ blocks }: { blocks: unknown }): React.ReactElement | null {
  if (!Array.isArray(blocks)) return null
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </>
  )
}

function BlockView({ block }: { block: unknown }): React.ReactElement {
  if (isBlock(block)) {
    switch (block["type"]) {
      case "hero":
        return <Hero block={block} />
      case "prose":
        return <Prose block={block} />
      case "speakerGrid":
        return <SpeakerGrid block={block} />
    }
  }
  // A block the schema does not declare cannot reach the database, so this is unreachable
  // through Studio. It exists because a hand-written seed can still do it, and a silently
  // dropped section is worse than a visible one.
  return <p className="ks-error">Unknown block type: {String(isBlock(block) ? block["type"] : block)}</p>
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

function Hero({ block }: { block: Block }): React.ReactElement {
  const cta = isBlock(block["cta"]) ? block["cta"] : null
  const href = text(cta?.["href"])
  return (
    <section className="ks-hero">
      <h2>{text(block["heading"]) ?? "Untitled"}</h2>
      {text(block["subheading"]) !== null && <p className="ks-lede">{text(block["subheading"])}</p>}
      {href !== null && <a className="ks-cta" href={href}>{text(cta?.["label"]) ?? "Read more"}</a>}
    </section>
  )
}

function Prose({ block }: { block: Block }): React.ReactElement {
  const body = block["body"]
  // Lexical state renders through @supatype/react's RichText in the app; here the plain-text
  // fallback is enough to show the block arriving, and keeps this file free of a client boundary.
  return <div className="ks-prose">{typeof body === "string" ? body : JSON.stringify(body)}</div>
}

function SpeakerGrid({ block }: { block: Block }): React.ReactElement {
  const limit = typeof block["limit"] === "number" ? block["limit"] : 6
  return (
    <section className="ks-grid">
      <h3>{text(block["heading"]) ?? "Speakers"}</h3>
      <p className="ks-muted">Showing up to {limit}, bounded by `Between&lt;Int, 3, 24&gt;` in the schema.</p>
    </section>
  )
}
