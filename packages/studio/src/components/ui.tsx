import React from "react"
import { Link } from "react-router-dom"
import { cn } from "../lib/utils.js"
import { IconX } from "./icons.js"

/* ─── Nav rail ─── */

/**
 * The horizontal rail the secondary panel's header and the tertiary nav each occupy.
 *
 * They start at the same y and sit side by side, so their bottom borders read as one line running
 * the width of the app. They were built separately and did not match: the nav was exactly 40px
 * (`h-10`) while the panel header was padding-derived (`pt-4 pb-2.5`, about 42px), and the two
 * borders were drawn at different opacities. The line stepped down and changed colour at the panel
 * edge.
 *
 * One constant rather than the same classes written twice, because the bug is drift: either height
 * can be adjusted alone and look correct in isolation.
 */
export const NAV_RAIL = "h-10 shrink-0 border-b border-border/80"

/* ─── Badge / Pill ─── */

export type BadgeVariant = "green" | "red" | "yellow" | "indigo" | "blue" | "outline"

const badgeColors: Record<BadgeVariant, string> = {
  green: "bg-green-500/15 text-green-400",
  red: "bg-red-500/15 text-red-400",
  yellow: "bg-yellow-500/15 text-yellow-400",
  indigo: "bg-indigo-500/15 text-indigo-400",
  blue: "bg-blue-500/15 text-blue-400",
  // No colour of its own: an outline badge is for callers that supply their own border and
  // text colour. It replaced a second Badge component that existed only for this one use.
  outline: "border border-border bg-transparent text-foreground",
}

export function Badge({
  variant = "green",
  children,
  className,
  ...props
}: {
  variant?: BadgeVariant
  children: React.ReactNode
  className?: string
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "className">): React.ReactElement {
  return (
    <span data-ui="badge" className={cn("inline-block whitespace-nowrap px-1.5 py-0.5 rounded-full text-[11px] font-medium", badgeColors[variant], className)} {...props}>
      {children}
    </span>
  )
}

/* ─── Button ─── */

type ButtonVariant = "secondary" | "primary" | "destructive" | "ghost"
type ButtonSize = "sm" | "md" | "xs" | "icon"

const buttonVariants: Record<ButtonVariant, string> = {
  secondary: "border border-border bg-secondary text-foreground hover:bg-accent",
  primary: "border bg-primary text-primary-foreground border-primary hover:opacity-90",
  destructive: "border bg-destructive text-destructive-foreground border-destructive hover:opacity-90",
  ghost: "text-muted-foreground hover:text-foreground hover:bg-accent",
}

const buttonSizes: Record<ButtonSize, string> = {
  // Square, for a button whose whole label is its glyph. The text sizes carry horizontal padding
  // meant for words, which around an icon reads as a gap rather than as a target. Sized to match
  // the icon buttons already in the top bar, and given a floor so a 12px glyph still has something
  // to hit.
  //
  // Note there is a second, unrelated `Button` in ./ui/button.tsx, which is what the package
  // exports publicly, and its `size="icon"` is a 40px square. The two components already disagree
  // about `sm`, `ghost` and `secondary`; this is one more name they share and do not agree on.
  icon: "h-7 w-7 justify-center shrink-0",
  xs: "px-2 py-1 text-[0.7rem]",
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
}

/** How a button looks, by variant and size: shared by {@link Button} and the links that wear its face. */
export interface ButtonLook {
  variant?: ButtonVariant
  size?: ButtonSize
}

function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "sm", className?: string): string {
  return cn("inline-flex items-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none", buttonSizes[size], buttonVariants[variant], className)
}

export function Button({
  variant,
  size,
  className,
  children,
  ...props
}: ButtonLook & {
  className?: string
  children: React.ReactNode
  ref?: React.Ref<HTMLButtonElement>
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">): React.ReactElement {
  return (
    <button data-ui="button" className={buttonClass(variant, size, className)} {...props}>
      {children}
    </button>
  )
}

type AnchorProps = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "href">

/**
 * Where a link goes: `href`, an address the browser loads (another site, a new tab), or `to`, a
 * route inside Studio, followed by the router so Studio's base path is kept and the app is not
 * reloaded. A plain href to a route left out the base path and opened the app afresh.
 */
export type LinkTarget = { href: string; to?: undefined } | { to: string; href?: undefined }

function isRoute(target: LinkTarget): target is { to: string; href?: undefined } {
  return target.to !== undefined
}

/**
 * An anchor for `dest`: the router's `Link` for a route, a plain `<a>` for an address. The one
 * place Studio draws either, so every link wears a face from this module.
 */
function Anchor({ dest, ...props }: { dest: LinkTarget } & AnchorProps & { className: string; "data-ui": string }): React.ReactElement {
  return isRoute(dest) ? <Link to={dest.to} {...props} /> : <a href={dest.href} {...props} />
}

/** Where a link goes, and the rest of its props, apart. */
function splitTarget<T extends LinkTarget>(props: T): { dest: LinkTarget; rest: Omit<T, "href" | "to"> } {
  const { href, to, ...rest } = props
  return { dest: to !== undefined ? { to } : { href: href ?? "" }, rest }
}

/**
 * A link that reads as a button: it goes somewhere (a new tab, a download, another screen) where a
 * {@link Button} would act. Takes a {@link Button}'s variant and size, and every anchor attribute.
 */
export function ButtonLink({ variant, size, className, children, ...props }: ButtonLook & LinkTarget & {
  className?: string
  children: React.ReactNode
} & AnchorProps): React.ReactElement {
  const { dest, rest } = splitTarget(props)
  return (
    <Anchor dest={dest} data-ui="button-link" className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </Anchor>
  )
}

/**
 * A link whose whole face is a glyph, the link twin of {@link IconButton}. `label` is required: it
 * is the link's accessible name and its tooltip, since a glyph alone names nothing to a screen
 * reader. Ghost and square by default.
 */
export function IconLink({ label, variant = "ghost", className, children, ...props }: {
  label: string
  href: string
  variant?: ButtonVariant
  className?: string
  children: React.ReactNode
} & Omit<AnchorProps, "aria-label" | "title">): React.ReactElement {
  return (
    <a data-ui="icon-link" aria-label={label} title={label} className={buttonClass(variant, "icon", className)} {...props}>
      {children}
    </a>
  )
}

/* ─── Button group ─── */

/**
 * Buttons joined into one control, such as an action and the menu of its alternatives.
 *
 * The group owns the joins so its buttons do not: they stretch to one height, the corners where
 * two meet are square, and a 1px divider separates them. Give every button the same variant and
 * size; the one that takes the spare width gets `flex-1 min-w-0`.
 *
 * `split` is the action-and-caret shape: the last button is a fixed 2rem caret, and the first is
 * inset on the left by the caret's width, so its label centres on the whole control. Stacked under
 * a full-width button, the two labels then share one centre line; without the inset the action's
 * label sat left of it by half the caret.
 */
export function ButtonGroup({
  className,
  children,
  split = false,
  ...props
}: {
  className?: string
  children: React.ReactNode
  split?: boolean
} & Omit<React.HTMLAttributes<HTMLDivElement>, "className">): React.ReactElement {
  return (
    <div
      role="group"
      className={cn(
        "flex min-w-0 items-stretch [&>*]:rounded-none [&>*:first-child]:rounded-l-md [&>*:last-child]:rounded-r-md [&>*+*]:border-l-primary-foreground/30",
        split && "[&>*:last-child]:w-8 [&>*:last-child]:shrink-0 [&>*:last-child]:justify-center [&>*:last-child]:px-0 [&>*:first-child]:pl-11",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

/* ─── Icon button ─── */

/**
 * A button whose whole face is a glyph. `label` is its accessible name and its tooltip, so a
 * screen reader and a pointer both learn what it does; the glyph goes in `children`. Ghost and
 * square by default, as the top bar's icon buttons are; any {@link Button} prop passes through.
 */
export function IconButton({
  label,
  variant = "ghost",
  size = "icon",
  children,
  ...props
}: {
  label: string
  children: React.ReactNode
} & Omit<React.ComponentProps<typeof Button>, "children" | "aria-label" | "title">): React.ReactElement {
  return (
    <Button type="button" variant={variant} size={size} aria-label={label} title={label} {...props}>
      {children}
    </Button>
  )
}

/* ─── Text link ─── */

export type TextLinkTone = "primary" | "muted"

const textLinkTones: Record<TextLinkTone, string> = {
  primary: "text-primary hover:underline",
  muted: "text-muted-foreground hover:text-foreground",
}

const TEXT_LINK_BASE =
  "inline-flex items-center gap-1.5 rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"

/** A {@link TextLink} that goes somewhere: an `<a>` with every anchor attribute. */
export type TextLinkAnchorProps = { href: string; to?: undefined } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "href">

/** A {@link TextLink} that acts on the page: a `<button>` (type="button") with every button attribute. */
export type TextLinkButtonProps = { href?: undefined; to?: undefined } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">

/** A {@link TextLink} to a route inside Studio, followed by the router. */
export type TextLinkRouteProps = { to: string; href?: undefined } & AnchorProps

export type TextLinkProps = { tone?: TextLinkTone; className?: string } & (TextLinkAnchorProps | TextLinkRouteProps | TextLinkButtonProps)

function isAnchorLink(props: TextLinkAnchorProps | TextLinkRouteProps | TextLinkButtonProps): props is TextLinkAnchorProps | TextLinkRouteProps {
  return props.href !== undefined || props.to !== undefined
}

/**
 * Words that read as a link. With `href` it is an anchor and navigates; without, it is a button
 * (type="button") that acts, for an action that reads as a link: "Set as default", a breadcrumb,
 * a file name that opens the file. `tone` "primary" underlines on hover; "muted" brightens.
 */
export function TextLink({ tone = "primary", className, ...props }: TextLinkProps): React.ReactElement {
  const look = cn(TEXT_LINK_BASE, textLinkTones[tone], className)
  if (isAnchorLink(props)) {
    const { dest, rest } = splitTarget(props)
    return <Anchor dest={dest} data-ui="text-link" className={look} {...rest} />
  }
  return <button type="button" data-ui="text-link" className={look} {...props} />
}

/* ─── List button ─── */

/**
 * One choice in a vertical list of choices (a table picker, a schema menu, a search result): full
 * width, left-aligned, highlighted on hover, and marked `aria-current` and filled while `selected`.
 * Pass `role="option"` and `aria-selected` instead when it lives in a listbox.
 */
export function ListButton({
  selected = false,
  className,
  children,
  ...props
}: {
  selected?: boolean
  className?: string
  children: React.ReactNode
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">): React.ReactElement {
  return (
    <button
      type="button"
      data-ui="list-button"
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed",
        selected && "bg-accent text-foreground font-medium",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

/* ─── Disclosure button ─── */

/**
 * The header of something that opens and closes in place (a request's detail, an event's payload):
 * full width, left-aligned, carrying `aria-expanded`. `open` is undefined for a header with nothing
 * to disclose, which is then disabled and claims no state. Padding is the caller's, to match the
 * card or row it heads.
 */
export function DisclosureButton({
  open,
  disabled = false,
  className,
  children,
  ...props
}: {
  open: boolean | undefined
  className?: string
  children: React.ReactNode
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "aria-expanded">): React.ReactElement {
  return (
    <button
      type="button"
      data-ui="disclosure-button"
      aria-expanded={open}
      disabled={open === undefined || disabled}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

/* ─── Tabs ─── */

/** One tab: the value it selects, what it reads as, and (for a tab that can be closed) its close. */
export interface TabItem<T extends string> {
  id: T
  label: React.ReactNode
  /** A close button beside the tab, named by `label` ("Close results 2"). */
  close?: { label: string; onClose: () => void }
}

/**
 * A set of tabs: its accessible name, its tabs in order, and how it looks. "underline" is a row of
 * page or panel tabs over a rule; "pill" is a segmented choice of filled and outlined chips; "tile"
 * is a row of equal bordered tiles whose label stacks an icon, a name and a line under it.
 */
export interface TabsSpec<T extends string> {
  label: string
  items: ReadonlyArray<TabItem<T>>
  look?: "underline" | "pill" | "tile"
  size?: "sm" | "xs"
}

const tabLooks = {
  underline: {
    list: "flex min-w-0 overflow-x-auto border-b border-border",
    tab: "-mb-px whitespace-nowrap border-b-2 px-3 py-2",
    on: "border-primary text-foreground",
    off: "border-transparent text-muted-foreground hover:text-foreground",
  },
  pill: {
    list: "flex min-w-0 flex-wrap items-center gap-2",
    tab: "whitespace-nowrap rounded-md border px-2.5 py-1",
    on: "border-primary bg-primary text-primary-foreground",
    off: "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
  },
  tile: {
    list: "grid min-w-0 grid-flow-col auto-cols-fr gap-1.5",
    tab: "relative flex flex-col items-center gap-1 rounded-lg border px-1 py-2.5 text-center",
    on: "border-primary/40 bg-primary/10 text-foreground",
    off: "border-border bg-secondary/20 text-muted-foreground hover:bg-secondary/40 hover:text-foreground",
  },
} as const

type TabLook = (typeof tabLooks)[keyof typeof tabLooks]

const TAB_FOCUS = "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

/** One tab's look: its shape, its type size, and whether it reads as selected. */
function tabClass(look: TabLook, size: TabsSpec<string>["size"], selected: boolean): string {
  return cn(look.tab, size === "xs" ? "text-xs" : "text-sm", selected ? look.on : look.off)
}

/** The tab an arrow key moves to from `current` (wrapping), the first for Home, the last for End. */
function tabAfter<T extends string>(ids: readonly T[], current: T, key: string): T | null {
  const at = ids.indexOf(current)
  const steps: Record<string, number> = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: ids.length - 1 }
  const next = steps[key]
  if (next === undefined || ids.length === 0) return null
  return ids[(next + ids.length) % ids.length] ?? null
}

/**
 * Tabs that pick one of `tabs.items`. A `tablist` whose selected tab is the one in the tab order;
 * the arrow keys, Home and End move between tabs and select as they go.
 */
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: TabsSpec<T>; value: T; onChange: (id: T) => void }): React.ReactElement {
  const look = tabLooks[tabs.look ?? "underline"]
  const ids = tabs.items.map((t) => t.id)
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = tabAfter(ids, value, e.key)
    if (next === null) return
    e.preventDefault()
    onChange(next)
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${CSS.escape(next)}"]`)?.focus()
  }
  return (
    <div role="tablist" aria-label={tabs.label} data-ui="tabs" className={look.list} onKeyDown={onKeyDown}>
      {tabs.items.map((t) => <OneTab key={t.id} item={t} look={{ shape: look, size: tabs.size, selected: t.id === value }} onSelect={onChange} />)}
    </div>
  )
}

/** One tab, and its close button beside it when it has one; the pair then shares the tab's look. */
function OneTab<T extends string>({ item, look, onSelect }: {
  item: TabItem<T>
  look: { shape: TabLook; size: TabsSpec<string>["size"]; selected: boolean }
  onSelect: (id: T) => void
}): React.ReactElement {
  const shown = tabClass(look.shape, look.size, look.selected)
  const tab = (
    <button
      type="button"
      role="tab"
      data-tab={item.id}
      aria-selected={look.selected}
      tabIndex={look.selected ? 0 : -1}
      className={cn(TAB_FOCUS, item.close ? "rounded-sm" : shown)}
      onClick={() => { onSelect(item.id) }}
    >
      {item.label}
    </button>
  )
  if (!item.close) return tab
  const { label, onClose } = item.close
  return (
    <div className={cn(shown, "flex items-center gap-1")}>
      {tab}
      <IconButton label={label} className="h-5 w-5" onClick={onClose}><IconX size={12} /></IconButton>
    </div>
  )
}

/* ─── Switch ─── */

/**
 * An on/off control that acts at once, such as a setting saved with its form: a `role="switch"`
 * button whose thumb slides across. `label` is its accessible name.
 */
export function Switch({ checked, onChange, label, ...props }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
} & Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, "id" | "disabled">): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      data-ui="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => { onChange(!checked) }}
      {...props}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted-foreground/30",
      )}
    >
      <span className={cn("pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm transition-transform", checked ? "translate-x-4" : "translate-x-0")} />
    </button>
  )
}

/* ─── Card ─── */

export function Card({
  className,
  children,
  ...props
}: {
  className?: string
  children: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, "className">): React.ReactElement {
  return (
    <div data-ui="card" className={cn("rounded-lg border border-border bg-card", className)} {...props}>
      {children}
    </div>
  )
}

/* ─── Popover ─── */

/**
 * A panel that drops below the control it belongs to, over what follows: a picker's options. Its
 * parent is the anchor and needs `relative`; it spans the parent's width.
 */
export function Popover({ className, children, ...props }: {
  className?: string
  children: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, "className">): React.ReactElement {
  return (
    <div data-ui="popover" className={cn("absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-border bg-popover p-1.5 shadow-xl", className)} {...props}>
      {children}
    </div>
  )
}

/* ─── Drop zone ─── */

/**
 * Where a file is dropped or chosen: a dashed outline round what it says and the buttons that
 * choose, lit while a file is dragged over it (`active`).
 */
export function DropZone({ active = false, className, children, ...props }: {
  active?: boolean
  className?: string
  children: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, "className">): React.ReactElement {
  return (
    <div
      data-ui="drop-zone"
      className={cn("flex flex-wrap items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-sm text-muted-foreground transition-colors", active ? "border-primary" : "border-border", className)}
      {...props}
    >
      {children}
    </div>
  )
}

/* ─── Avatar ─── */

const avatarSizes = { sm: "h-5 w-5 text-[0.55rem]", md: "h-6 w-6 text-[0.6rem]", lg: "h-9 w-9 text-xs" } as const

/** Someone or something as its initials in a circle, where there is no picture of it. */
export function Avatar({ initials, size = "md" }: { initials: string; size?: keyof typeof avatarSizes }): React.ReactElement {
  return (
    <span data-ui="avatar" aria-hidden="true" className={cn("flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold tracking-tight text-foreground", avatarSizes[size])}>
      {initials}
    </span>
  )
}

/* ─── Dialog ─── */

/**
 * A modal question over the page: a title, what it means, and the buttons that answer it.
 *
 * The overlay and the card are the ones the database views each wrote out by hand. `role` is
 * `alertdialog` when the question guards something that cannot be taken back.
 */
/** The dimmed layer under a {@link Dialog} or a {@link Modal}, centring what it holds. */
const OVERLAY = "fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"

export function Dialog({
  title,
  children,
  actions,
  role = "dialog",
}: {
  title: string
  children: React.ReactNode
  actions: React.ReactNode
  role?: "dialog" | "alertdialog"
}): React.ReactElement {
  return (
    <div className={OVERLAY}>
      <Card data-ui="dialog" role={role} aria-modal="true" aria-label={title} className="p-6 w-full max-w-md space-y-4 shadow-xl">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
        <div className="flex justify-end gap-2">{actions}</div>
      </Card>
    </div>
  )
}

/**
 * The answers to an `alertdialog`: Cancel, and the destructive act named by `label`. Either one
 * closes the question; the act runs after it closes.
 */
export function DestructiveAnswers({ label, act, onClose }: { label: string; act: () => void; onClose: () => void }): React.ReactElement {
  return (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="destructive" onClick={() => { onClose(); act() }}>{label}</Button>
    </>
  )
}

/** What a {@link ConfirmButton} asks before it acts. */
export interface DestructiveQuestion {
  /** The question, naming what it acts on: `Drop policy owner_read on auth.users?` */
  title: string
  /** What answering yes does, and what it cannot undo. */
  detail: React.ReactNode
  /** The answer that acts, naming the act: `Drop policy`. */
  answer: string
}

/**
 * A button whose act cannot be taken back, so the click asks first. The act runs only on the
 * destructive answer; Cancel leaves everything as it was. Takes every {@link Button} prop but
 * `onClick`, which is the act's to own.
 */
export function ConfirmButton({
  ask,
  act,
  children,
  ...props
}: {
  ask: DestructiveQuestion
  act: () => void
  children: React.ReactNode
} & Omit<React.ComponentProps<typeof Button>, "onClick" | "children">): React.ReactElement {
  const [asking, setAsking] = React.useState(false)
  const close = (): void => { setAsking(false) }
  return (
    <>
      <Button {...props} onClick={() => { setAsking(true) }}>{children}</Button>
      {asking ? (
        <Dialog role="alertdialog" title={ask.title} actions={<DestructiveAnswers label={ask.answer} act={act} onClose={close} />}>
          {ask.detail}
        </Dialog>
      ) : null}
    </>
  )
}

/* ─── Modal ─── */

/** Calls `onEscape` when Escape is pressed anywhere on the page, while `active`. */
export function useEscapeKey(onEscape: () => void, active = true): void {
  React.useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") onEscape() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onEscape, active])
}

/**
 * A panel of its own over the page, for a task rather than a question: picking a file from a
 * bucket. Wider than a {@link Dialog}, its content lays out its own header and body, and it closes
 * on Escape or a click outside it. `label` is its accessible name.
 */
export function Modal({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }): React.ReactElement {
  useEscapeKey(onClose)
  return (
    <div className={OVERLAY} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <Card data-ui="modal" role="dialog" aria-modal="true" aria-label={label} className="flex max-h-[min(560px,90vh)] w-full max-w-2xl flex-col overflow-hidden shadow-xl">
        {children}
      </Card>
    </div>
  )
}

/* ─── Input ─── */

/** The border, fill and focus ring every form control shares. */
const FIELD_FRAME = "rounded-md border border-border bg-background text-foreground text-sm focus:outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"

/**
 * A disabled control has to *look* disabled. Without these it renders identically to an editable
 * one, so a field the form will never read looks like a field you forgot to fill in, and clicking
 * it does nothing with no explanation. A refused one has a red border.
 */
const FIELD_STATES = "disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed aria-[invalid=true]:border-destructive"

/**
 * A control made of several parts that reads as one field: a search box with its own buttons
 * beside it, a picked record and the controls that clear or open it. It wears a form control's
 * border and fill, and its focus ring lights while any part of it has focus.
 */
export function FieldFrame({ className, children, ...props }: {
  className?: string
  children: React.ReactNode
  ref?: React.Ref<HTMLDivElement>
} & Omit<React.HTMLAttributes<HTMLDivElement>, "className">): React.ReactElement {
  return (
    <div data-ui="field-frame" className={cn(FIELD_FRAME, "flex w-full min-w-0 items-center gap-2 px-3 py-1 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20", className)} {...props}>
      {children}
    </div>
  )
}

/**
 * Form controls carry `data-ui` naming the primitive, so a test can tell a control built from this
 * module from a hand-rolled one by looking at the rendered tree.
 */
export function Input({
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "className"> & { className?: string; ref?: React.Ref<HTMLInputElement> }): React.ReactElement {
  return (
    <input
      data-ui="input"
      className={cn("w-full px-3 py-1.5", FIELD_FRAME, FIELD_STATES, "disabled:border-border/60 disabled:focus:ring-0 disabled:focus:border-border/60", className)}
      {...props}
    />
  )
}

/**
 * The browser's file chooser, never drawn: a button elsewhere opens it through `ref`. `onFiles`
 * hears the files chosen, and is not called when the chooser is dismissed with none.
 */
export function FileInput({ onFiles, ...props }: {
  onFiles: (files: FileList) => void
  ref?: React.Ref<HTMLInputElement>
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "className" | "hidden">): React.ReactElement {
  return (
    <input
      type="file"
      hidden
      data-ui="file-input"
      onChange={(e) => { if (e.target.files !== null && e.target.files.length > 0) onFiles(e.target.files) }}
      {...props}
    />
  )
}

/* ─── Select ─── */

export function Select({
  className,
  children,
  ...props
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "className"> & { className?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <select
      data-ui="select"
      className={cn("px-3 py-1.5", FIELD_FRAME, FIELD_STATES, className)}
      {...props}
    >
      {children}
    </select>
  )
}

/* ─── Textarea ─── */

/**
 * A multi-line input with {@link Input}'s border and focus ring. By default in the monospace face
 * {@link CodeBlock} uses, for text that is code: a JSON payload, a query. `face="prose"` is for
 * words a person reads: a description, a summary.
 */
export function Textarea({
  className,
  face = "code",
  ...props
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & { className?: string; face?: "code" | "prose"; ref?: React.Ref<HTMLTextAreaElement> }): React.ReactElement {
  return (
    <textarea
      data-ui="textarea"
      className={cn("w-full px-3 py-2", FIELD_FRAME, FIELD_STATES, face === "code" && "font-mono", className)}
      {...props}
    />
  )
}

/* ─── Checkbox ─── */

/**
 * A checkbox with its label, the whole of which toggles it. Disabled reads as disabled: the label
 * dims and the pointer stops promising a click.
 */
export function Checkbox({
  label,
  className,
  disabled,
  ...props
}: {
  label: React.ReactNode
  className?: string
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "className" | "type">): React.ReactElement {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-1.5 text-xs text-muted-foreground select-none",
        disabled === true ? "opacity-60 cursor-not-allowed" : "cursor-pointer",
        className,
      )}
    >
      <input type="checkbox" data-ui="checkbox" className="rounded" disabled={disabled} {...props} />
      {label}
    </label>
  )
}

/* ─── Table primitives ─── */

export function Th({
  className,
  children,
  ...props
}: {
  className?: string
  children?: React.ReactNode
} & Omit<React.ThHTMLAttributes<HTMLTableCellElement>, "className">): React.ReactElement {
  return (
    <th data-ui="th" className={cn("text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap", className)} {...props}>
      {children}
    </th>
  )
}

/** Which way a column is sorted, or null when the rows are not in its order. */
export type SortDirection = "ascending" | "descending" | null

/**
 * A {@link Th} whose column sorts the table. The header cell takes the click, and the button inside
 * it carries the keyboard, so Tab reaches it and Enter or Space sorts; `aria-sort` and an arrow say
 * which way the rows run.
 */
export function SortTh({ sort, onSort, children, ...props }: {
  sort: SortDirection
  onSort: () => void
  children: React.ReactNode
} & Omit<React.ComponentProps<typeof Th>, "onClick" | "aria-sort" | "children">): React.ReactElement {
  return (
    <Th aria-sort={sort ?? undefined} onClick={onSort} {...props} className={cn("cursor-pointer select-none hover:text-foreground", props.className)}>
      <button type="button" data-ui="sort-button" className="inline-flex items-center gap-1 uppercase tracking-wider rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {children}
        {sort !== null ? <span aria-hidden="true">{sort === "ascending" ? "↑" : "↓"}</span> : null}
      </button>
    </Th>
  )
}

export function Td({
  className,
  children,
  ...props
}: {
  className?: string
  children?: React.ReactNode
} & Omit<React.TdHTMLAttributes<HTMLTableCellElement>, "className">): React.ReactElement {
  return (
    <td data-ui="td" className={cn("px-3 py-2 text-sm", className)} {...props}>
      {children}
    </td>
  )
}

/**
 * A table of {@link Th} and {@link Td} cells, full width in the shared type size. For a list in a
 * card of its own use {@link TableCard}; use this where the table sits in something else (a panel,
 * a card with a heading) or needs its own `<thead>` (fixed column widths, a second header row).
 */
export function Table({
  className,
  children,
  ...props
}: {
  className?: string
  children: React.ReactNode
} & Omit<React.TableHTMLAttributes<HTMLTableElement>, "className">): React.ReactElement {
  return (
    <table data-ui="table" className={cn("w-full text-sm", className)} {...props}>
      {children}
    </table>
  )
}

/**
 * A list as a table in a {@link Card}: a header row of {@link Th} cells over rows of {@link Td}.
 * A table wider than the screen scrolls inside the card, so a phone never scrolls the page sideways.
 */
export function TableCard({ head, children }: { head: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return (
    <Card data-ui="table-card" className="overflow-x-auto">
      <Table>
        <thead>
          <tr className="border-b border-border bg-muted/40">{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </Table>
    </Card>
  )
}

/** The class a {@link TableCard} row takes; a row that opens something on click says so on hover. */
export function tableRowClass(clickable: boolean): string {
  return cn("border-b border-border last:border-0", clickable && "hover:bg-muted/20 cursor-pointer")
}

/* ─── Skeletons ─── */

/**
 * One pulsing placeholder for something still loading. Its shape is the caller's: a height and
 * width, and a radius or a card's border where the thing it stands in for has one.
 */
export function Skeleton({ className }: { className?: string }): React.ReactElement {
  return <div data-ui="skeleton" className={cn("rounded-md bg-muted animate-pulse", className)} />
}

/** The placeholder rows a list shows while its first page loads; `rowClassName` resizes each row. */
export function LoadingRows({ count = 3, rowClassName }: { count?: number; rowClassName?: string }): React.ReactElement {
  return (
    <div data-ui="loading-rows" className="space-y-2">
      {Array.from({ length: count }, (_, i) => <Skeleton key={i} className={cn("h-10", rowClassName)} />)}
    </div>
  )
}

/** A settings card while its settings load: a heading, then `rows` label-and-control rows. */
export function LoadingSettingsCard({ rows }: { rows: number }): React.ReactElement {
  return (
    <Card>
      <div className="px-4 py-3 border-b border-border"><Skeleton className="h-4 w-24 rounded" /></div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex justify-between px-4 py-3">
            <Skeleton className="h-4 w-20 rounded" />
            <Skeleton className="h-7 w-32 rounded" />
          </div>
        ))}
      </div>
    </Card>
  )
}

/* ─── Page header ─── */

/**
 * A screen's title, the control that scopes it (a schema picker) beside the title, and its main
 * action at the far end. On a narrow screen the action wraps under the title rather than pushing
 * the page sideways.
 */
export function PageHeader({ title, scope, action }: { title: string; scope?: React.ReactNode; action?: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        {scope}
      </div>
      {action}
    </div>
  )
}

/** In place of a screen that cannot be shown: a model, global or record that is not there. */
export function PageError({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="p-3 text-destructive-text bg-destructive/10 rounded-md text-sm">{children}</div>
}

/* ─── Code block ─── */

export function CodeBlock({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className={cn("rounded-md border border-border bg-background p-4 font-mono text-sm overflow-x-auto whitespace-pre", className)}>
      {children}
    </div>
  )
}

/* ─── Pager ─── */

/** Where a paged list is: the zero-based page, its size, and how many rows there are in all. */
export interface PageAt {
  page: number
  pageSize: number
  total: number
}

/**
 * "Page 2 of 7 (163)" with Previous and Next, for any list fetched a page at a time. `busy` while the
 * next page loads: the buttons wait for it rather than paging from rows about to be replaced.
 */
export function Pager({
  at,
  onPage,
  busy = false,
}: {
  at: PageAt
  onPage: (page: number) => void
  busy?: boolean
}): React.ReactElement {
  const pages = Math.max(1, Math.ceil(at.total / at.pageSize))
  return (
    <div className="flex items-center justify-end gap-2 mt-2">
      <span className="text-xs text-muted-foreground">
        {busy ? "Loading… " : ""}Page {at.page + 1} of {pages} ({at.total})
      </span>
      <Button size="sm" onClick={() => onPage(at.page - 1)} disabled={busy || at.page === 0}>
        Previous
      </Button>
      <Button size="sm" onClick={() => onPage(at.page + 1)} disabled={busy || at.page >= pages - 1}>
        Next
      </Button>
    </div>
  )
}
