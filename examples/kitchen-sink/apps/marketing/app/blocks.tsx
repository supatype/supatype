import React from "react"
import { RichText } from "@supatype/react"
import type { TableRow } from "@supatype/client"
import { localized } from "@/lib/localized"

/**
 * The block vocabulary, rendered.
 *
 * `Page.body` is `Blocks<HeroBlock | ProseBlock | SpeakerGridBlock>`, a closed set an editor
 * arranges, not a rich-text column with pasted HTML in it. The payoff is here: each block has a
 * known shape, so rendering is a switch rather than sanitising someone's markup.
 *
 * Each entry is `{ type, data }`, the block's fields under `data`, which is what Studio's editor
 * writes and what the generated row type says. The text fields are localized, so they hold every
 * language at once and the page picks one.
 */
type PageBlocks = TableRow<"page">["body"]
type PageBlock = PageBlocks[number]
type DataOf<T extends PageBlock["type"]> = Extract<PageBlock, { type: T }>["data"]
type BlockProps<T extends PageBlock["type"]> = { data: DataOf<T>; locale: string }

export function Blocks({ blocks, locale }: { blocks: PageBlocks; locale: string }): React.ReactElement {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} locale={locale} />
      ))}
    </>
  )
}

function BlockView({ block, locale }: { block: PageBlock; locale: string }): React.ReactElement {
  // A page seeded before blocks kept their fields under `data` stores them beside `type`. Said
  // plainly rather than rendered as an empty section; UPGRADING.md has the SQL that moves them.
  if (typeof block.data !== "object" || block.data === null) {
    return <p className="ks-error">This {block.type} block has no data. Re-seed the page or save it again in Studio.</p>
  }
  switch (block.type) {
    case "hero":
      return <Hero data={block.data} locale={locale} />
    case "prose":
      return <Prose data={block.data} locale={locale} />
    case "speakerGrid":
      return <SpeakerGrid data={block.data} locale={locale} />
    // Unreachable through Studio, which offers only the declared blocks. A hand-written seed can
    // still store another, and a section that vanishes silently is worse than one that says why.
    default:
      return <p className="ks-error">Unknown block type</p>
  }
}

function Hero({ data, locale }: BlockProps<"hero">): React.ReactElement {
  const subheading = localized(data.subheading, locale)
  return (
    <section className="ks-hero">
      <h2>{localized(data.heading, locale) ?? "Untitled"}</h2>
      {subheading !== null && <p className="ks-lede">{subheading}</p>}
      {data.cta !== undefined && <a className="ks-cta" href={data.cta.href}>{data.cta.label}</a>}
    </section>
  )
}

function Prose({ data, locale }: BlockProps<"prose">): React.ReactElement {
  return <RichText content={localized(data.body, locale)} className="ks-prose" />
}

function SpeakerGrid({ data, locale }: BlockProps<"speakerGrid">): React.ReactElement {
  return (
    <section className="ks-grid">
      <h3>{localized(data.heading, locale) ?? "Speakers"}</h3>
      <p className="ks-muted">Showing up to {data.limit}, bounded by `Between&lt;Int, 3, 24&gt;` in the schema.</p>
    </section>
  )
}
