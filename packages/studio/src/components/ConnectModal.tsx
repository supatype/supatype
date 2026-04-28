import React, { useState, useCallback } from "react"
import { cn } from "../lib/utils.js"
import { SlidePanel } from "./SlidePanel.js"
import { Select } from "./ui.js"

type Tab = "sdk" | "direct" | "mcp"
type Framework = "nextjs" | "react" | "vue" | "svelte" | "solid" | "vanilla"
type NextVariant = "app-router" | "app-router-ssr" | "pages-router" | "pages-router-ssr"

const NEXT_VARIANTS: Array<{ id: NextVariant; label: string }> = [
  { id: "app-router",     label: "App Router"       },
  { id: "app-router-ssr", label: "App Router — SSR"  },
  { id: "pages-router",   label: "Pages Router"      },
  { id: "pages-router-ssr", label: "Pages Router — SSR" },
]

function isSSR(v: NextVariant): boolean {
  return v === "app-router-ssr" || v === "pages-router-ssr"
}

interface ConnectModalProps {
  open: boolean
  onClose: () => void
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => undefined)
  }, [text])
  return (
    <button
      type="button"
      onClick={copy}
      className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
      aria-label="Copy to clipboard"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? "Copied!" : label}
    </button>
  )
}

function CodeBlock({ code, filename }: { code: string; filename?: string }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden text-xs font-mono">
      <div className="flex items-center justify-between px-3 py-1.5 bg-secondary/40 border-b border-border">
        <span className="text-muted-foreground truncate">{filename ?? "snippet"}</span>
        <CopyButton text={code} />
      </div>
      <pre className="p-4 overflow-x-auto text-foreground/85 leading-relaxed bg-canvas whitespace-pre">
        {code}
      </pre>
    </div>
  )
}

function Step({ n, title, children, last }: { n: number; title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center shrink-0 pt-0.5">
        <span className="flex items-center justify-center w-5 h-5 rounded-full border border-border text-[11px] text-muted-foreground font-medium shrink-0">
          {n}
        </span>
        {!last && <div className="w-px flex-1 bg-border/60 mt-2" />}
      </div>
      <div className={cn("flex-1 min-w-0", last ? "pb-0" : "pb-5")}>
        <p className="text-sm font-medium text-foreground mb-2.5">{title}</p>
        <div className="space-y-2">{children}</div>
      </div>
    </div>
  )
}

// ── Tab definitions ───────────────────────────────────────────────────────────

const TABS: Array<{ id: Tab; label: string; subtitle: string; icon: React.ReactElement; recommended?: boolean }> = [
  {
    id: "sdk",
    label: "SDK",
    subtitle: "Client library",
    recommended: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
      </svg>
    ),
  },
  {
    id: "direct",
    label: "Direct",
    subtitle: "Connection string",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5" /><path d="M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6" />
      </svg>
    ),
  },
  {
    id: "mcp",
    label: "MCP",
    subtitle: "Connect your agent",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
      </svg>
    ),
  },
]

const FRAMEWORKS: Array<{ id: Framework; label: string }> = [
  { id: "nextjs",  label: "Next.js"    },
  { id: "react",   label: "React"      },
  { id: "vue",     label: "Vue"        },
  { id: "svelte",  label: "Svelte"     },
  { id: "solid",   label: "Solid"      },
  { id: "vanilla", label: "JavaScript" },
]

// ── Snippet generators ────────────────────────────────────────────────────────

function getClientFile(fw: Framework, variant: NextVariant): { filename: string; code: string } {
  const ssr = fw === "nextjs" && isSSR(variant)
  const isAppRouter = variant === "app-router-ssr"

  if (ssr && isAppRouter) {
    return {
      filename: "utils/supatype-server.ts",
      code: `import { createServerClient } from '@supatype/ssr'
import { cookies } from 'next/headers'
import type { Database } from './types/supatype'

export async function createSupatypeClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(
    process.env.SUPATYPE_URL!,
    process.env.SUPATYPE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll() { /* session refresh handled in middleware */ },
      },
    },
  )
}`,
    }
  }

  if (ssr) {
    // pages-router-ssr: no separate util — client created inline in getServerSideProps
    return {
      filename: "utils/supatype-server.ts",
      code: `import { createServerClient } from '@supatype/ssr'
import type { Database } from './types/supatype'
import type { IncomingMessage, ServerResponse } from 'http'

export function createSupatypeClient(req: IncomingMessage, res: ServerResponse) {
  return createServerClient<Database>(
    process.env.SUPATYPE_URL!,
    process.env.SUPATYPE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return Object.entries(req.cookies ?? {}).map(([name, value]) => ({
            name, value: value ?? '',
          }))
        },
        setAll(toSet) {
          toSet.forEach(({ name, value, options }) => {
            const attrs = [
              \`\${name}=\${value}\`,
              \`Path=\${options?.path ?? '/'}\`,
              options?.httpOnly ? 'HttpOnly' : '',
              options?.secure  ? 'Secure'   : '',
            ].filter(Boolean).join('; ')
            res.setHeader('Set-Cookie', attrs)
          })
        },
      },
    },
  )
}`,
    }
  }

  const envPrefix = fw === "react" ? "process.env.NEXT_PUBLIC_"
    : (fw === "vue" || fw === "svelte" || fw === "solid") ? "import.meta.env.VITE_"
    : fw === "nextjs" ? "process.env.NEXT_PUBLIC_"
    : ""
  const urlEnv = fw === "vanilla" ? "'YOUR_SUPATYPE_URL'"     : `${envPrefix}SUPATYPE_URL!`
  const keyEnv = fw === "vanilla" ? "'YOUR_SUPATYPE_ANON_KEY'" : `${envPrefix}SUPATYPE_ANON_KEY!`

  return {
    filename: fw === "svelte" ? "src/lib/supatype.ts" : "utils/supatype.ts",
    code: `import { createClient } from '@supatype/client'
import type { Database } from './types/supatype'

export const supatype = createClient<Database>({
  url: ${urlEnv},
  anonKey: ${keyEnv},
})`,
  }
}

function getEnvFile(fw: Framework, variant: NextVariant): string {
  const ssr = fw === "nextjs" && isSSR(variant)
  const prefix = fw === "react" ? "NEXT_PUBLIC_"
    : (fw === "vue" || fw === "svelte" || fw === "solid") ? "VITE_"
    : fw === "vanilla" ? ""
    : fw === "nextjs" && ssr ? ""
    : "NEXT_PUBLIC_"
  return `${prefix}SUPATYPE_URL=your-project-url\n${prefix}SUPATYPE_ANON_KEY=your-anon-key`
}

function getProviderSetup(fw: Framework, variant: NextVariant): { filename: string; code: string } | null {
  if (isSSR(variant)) return null  // SSR variants don't need a client-side provider
  if (fw === "nextjs" && variant === "app-router") {
    return {
      filename: "app/providers.tsx",
      code: `'use client'
import { SupatypeProvider } from '@supatype/react'
import { supatype } from '@/utils/supatype'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SupatypeProvider client={supatype}>
      {children}
    </SupatypeProvider>
  )
}`,
    }
  }
  if (fw === "nextjs" && variant === "pages-router") {
    return {
      filename: "pages/_app.tsx",
      code: `import { SupatypeProvider } from '@supatype/react'
import { supatype } from '../utils/supatype'
import type { AppProps } from 'next/app'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <SupatypeProvider client={supatype}>
      <Component {...pageProps} />
    </SupatypeProvider>
  )
}`,
    }
  }
  if (fw === "react") {
    return {
      filename: "src/main.tsx",
      code: `import ReactDOM from 'react-dom/client'
import { SupatypeProvider } from '@supatype/react'
import { supatype } from './utils/supatype'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <SupatypeProvider client={supatype}>
    <App />
  </SupatypeProvider>
)`,
    }
  }
  return null
}

function getUsageSnippet(fw: Framework, variant: NextVariant): { filename: string; code: string } {
  if (fw === "nextjs" && variant === "app-router") {
    return {
      filename: "app/page.tsx",
      code: `'use client'
import { useQuery } from '@supatype/react'

export default function Page() {
  const { data, loading } = useQuery('posts', {
    order: [{ field: 'created_at', direction: 'desc' }],
    limit: 10,
  })

  if (loading) return <p>Loading…</p>
  return (
    <ul>
      {data?.map(post => <li key={post.id}>{post.title}</li>)}
    </ul>
  )
}`,
    }
  }
  if (fw === "nextjs" && variant === "app-router-ssr") {
    return {
      filename: "app/page.tsx",
      code: `import { createSupatypeClient } from '@/utils/supatype-server'

// This is a React Server Component — no 'use client' needed
export default async function Page() {
  const supatype = await createSupatypeClient()
  const { data } = await supatype
    .from('posts')
    .select()
    .order('created_at', { ascending: false })
    .limit(10)

  return (
    <ul>
      {data?.map(post => <li key={post.id}>{post.title}</li>)}
    </ul>
  )
}`,
    }
  }
  if (fw === "nextjs" && variant === "pages-router") {
    return {
      filename: "pages/index.tsx",
      code: `import { useQuery } from '@supatype/react'

export default function Home() {
  const { data, loading } = useQuery('posts')
  if (loading) return <p>Loading…</p>
  return (
    <ul>
      {data?.map(post => <li key={post.id}>{post.title}</li>)}
    </ul>
  )
}`,
    }
  }
  if (fw === "nextjs" && variant === "pages-router-ssr") {
    return {
      filename: "pages/index.tsx",
      code: `import { createSupatypeClient } from '../utils/supatype-server'
import type { GetServerSideProps, InferGetServerSidePropsType } from 'next'

type Post = { id: string; title: string }

export const getServerSideProps: GetServerSideProps<{ posts: Post[] }> = async ({ req, res }) => {
  const supatype = createSupatypeClient(req, res)
  const { data } = await supatype.from('posts').select()
  return { props: { posts: data ?? [] } }
}

export default function Home({
  posts,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <ul>
      {posts.map(post => <li key={post.id}>{post.title}</li>)}
    </ul>
  )
}`,
    }
  }
  if (fw === "react") {
    return {
      filename: "src/Posts.tsx",
      code: `import { useQuery } from '@supatype/react'

export function Posts() {
  const { data, loading } = useQuery('posts')
  if (loading) return <p>Loading…</p>
  return (
    <ul>
      {data?.map(post => <li key={post.id}>{post.title}</li>)}
    </ul>
  )
}`,
    }
  }
  if (fw === "vue") {
    return {
      filename: "src/Posts.vue",
      code: `<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { supatype } from '@/utils/supatype'

const posts = ref<Array<{ id: string; title: string }>>([])
onMounted(async () => {
  const { data } = await supatype.from('posts').select()
  if (data) posts.value = data
})
</script>

<template>
  <ul>
    <li v-for="post in posts" :key="post.id">{{ post.title }}</li>
  </ul>
</template>`,
    }
  }
  if (fw === "svelte") {
    return {
      filename: "src/routes/+page.svelte",
      code: `<script lang="ts">
  import { supatype } from '$lib/supatype'
  let posts: Array<{ id: string; title: string }> = []
  async function load() {
    const { data } = await supatype.from('posts').select()
    if (data) posts = data
  }
  load()
</script>

<ul>
  {#each posts as post}
    <li>{post.title}</li>
  {/each}
</ul>`,
    }
  }
  if (fw === "solid") {
    return {
      filename: "src/Posts.tsx",
      code: `import { createResource, For } from 'solid-js'
import { supatype } from './utils/supatype'

export function Posts() {
  const [posts] = createResource(async () => {
    const { data } = await supatype.from('posts').select()
    return data ?? []
  })
  return (
    <ul>
      <For each={posts()}>{post => <li>{post.title}</li>}</For>
    </ul>
  )
}`,
    }
  }
  return {
    filename: "main.js",
    code: `import { createClient } from '@supatype/client'

const supatype = createClient({
  url: 'YOUR_SUPATYPE_URL',
  anonKey: 'YOUR_SUPATYPE_ANON_KEY',
})

const { data } = await supatype.from('posts').select()
console.log(data)`,
  }
}

function getAgentPrompt(fw: Framework, variant: NextVariant): string {
  const ssr = fw === "nextjs" && isSSR(variant)
  const useHooks = (fw === "nextjs" || fw === "react") && !ssr
  const variantLabel = fw === "nextjs"
    ? NEXT_VARIANTS.find(v => v.id === variant)?.label ?? variant
    : fw
  return `I'm building a ${fw === "nextjs" ? `Next.js (${variantLabel})` : fw} app with Supatype as the backend.

Install packages:
npm install @supatype/client${useHooks ? " @supatype/react" : ""}

Set env vars in .env.local:
${getEnvFile(fw, variant)}

Create ${getClientFile(fw, variant).filename}:
${getClientFile(fw, variant).code}

${useHooks ? "Wrap the app in <SupatypeProvider client={supatype}> from @supatype/react.\n\nUse useQuery / useMutation hooks for data access." : ssr ? "Create a server client per-request using createSupatypeClient(). Fetch data directly in server components or getServerSideProps." : "Use the client directly: supatype.from('table').select()"}`
}

// ── Tab content panels ────────────────────────────────────────────────────────

interface SdkContentProps {
  framework: Framework
  setFramework: (f: Framework) => void
  variant: NextVariant
  setVariant: (v: NextVariant) => void
}

function SdkContent({ framework, setFramework, variant, setVariant }: SdkContentProps) {
  const ssr         = framework === "nextjs" && isSSR(variant)
  const useHooks    = (framework === "nextjs" || framework === "react") && !ssr
  const installCmd  = `npm install @supatype/client${ssr ? " @supatype/ssr" : useHooks ? " @supatype/react" : ""}`
  const { filename: clientFilename, code: clientFileCode } = getClientFile(framework, variant)
  const providerSetup = getProviderSetup(framework, variant)
  const usage         = getUsageSnippet(framework, variant)
  const lastStep      = providerSetup ? 5 : 4

  return (
    <div className="space-y-4">
      {/* Selectors */}
      <div className="flex gap-3">
        <div className="flex-1 space-y-1">
          <label className="text-xs text-muted-foreground font-medium">Framework</label>
          <Select
            value={framework}
            onChange={e => setFramework(e.target.value as Framework)}
            className="w-full"
          >
            {FRAMEWORKS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
          </Select>
        </div>
        {framework === "nextjs" && (
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground font-medium">Variant</label>
            <Select
              value={variant}
              onChange={e => setVariant(e.target.value as NextVariant)}
              className="w-full"
            >
              {NEXT_VARIANTS.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
            </Select>
          </div>
        )}
      </div>

      {/* Agent prompt */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/20 px-3 py-2.5">
        <span className="text-xs font-medium text-foreground">Give your agent everything it needs</span>
        <CopyButton text={getAgentPrompt(framework, variant)} label="Copy prompt" />
      </div>

      {/* Steps */}
      <div className="pt-1">
        <Step n={1} title="Install packages">
          <CodeBlock code={installCmd} filename="terminal" />
        </Step>
        <Step n={2} title="Add environment variables">
          <CodeBlock code={getEnvFile(framework, variant)} filename=".env.local" />
        </Step>
        <Step n={3} title={ssr ? "Create your server client" : "Create your Supatype client"}>
          <CodeBlock code={clientFileCode} filename={clientFilename} />
        </Step>
        {providerSetup && (
          <Step n={4} title="Wrap your app with the provider">
            <CodeBlock code={providerSetup.code} filename={providerSetup.filename} />
          </Step>
        )}
        <Step n={lastStep} title="Use in your app" last>
          <CodeBlock code={usage.code} filename={usage.filename} />
        </Step>
      </div>
    </div>
  )
}

function DirectContent() {
  const conn = `postgresql://postgres:[YOUR-PASSWORD]@[YOUR-HOST]:5432/postgres`
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Connect directly to Postgres — useful for migrations, scripts, or any tool that takes a connection string.
      </p>
      <Step n={1} title="Connection string">
        <CodeBlock code={conn} filename="connection string" />
      </Step>
      <Step n={2} title="Connect with psql" last>
        <CodeBlock code={`psql '${conn}'`} filename="terminal" />
      </Step>
      <div className="rounded-lg border border-border bg-secondary/20 px-3 py-2.5 text-xs text-muted-foreground">
        Find your host and password in <span className="text-foreground font-medium">Settings → Database</span>.
        For app integrations, the <span className="text-primary font-medium">SDK</span> tab gives you type-safe queries with no SQL.
      </div>
    </div>
  )
}


function McpContent() {
  const config = `{
  "mcpServers": {
    "supatype": {
      "command": "npx",
      "args": ["@supatype/mcp"],
      "env": {
        "SUPATYPE_URL": "YOUR_SUPATYPE_URL",
        "SUPATYPE_SERVICE_KEY": "YOUR_SERVICE_ROLE_KEY"
      }
    }
  }
}`
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Connect your AI agent directly to your project via MCP. Works with Claude Desktop, Cursor, Windsurf, and any MCP-compatible tool.
      </p>
      <Step n={1} title="Add to your agent config">
        <CodeBlock code={config} filename="claude_desktop_config.json / .cursor/mcp.json" />
      </Step>
      <Step n={2} title="Environment variables" last>
        <CodeBlock code={`SUPATYPE_URL=your-project-url\nSUPATYPE_SERVICE_KEY=your-service-role-key`} filename=".env" />
      </Step>
      <div className="rounded-lg border border-border bg-secondary/20 px-3 py-2.5 text-xs text-muted-foreground">
        The service role key bypasses RLS — use it only in trusted environments. Find it in <span className="text-foreground font-medium">Settings → API</span>.
      </div>
    </div>
  )
}

// ── Slide-in panel ────────────────────────────────────────────────────────────

export function ConnectModal({ open, onClose }: ConnectModalProps): React.ReactElement {
  const [tab, setTab]           = useState<Tab>("sdk")
  const [framework, setFramework] = useState<Framework>("nextjs")
  const [variant, setVariant]     = useState<NextVariant>("app-router")

  return (
    <SlidePanel
      open={open}
      onClose={onClose}
      title="Connect to your project"
      subtitle="Choose how you want to use Supatype"
      width="max-w-[460px]"
    >
      {/* Tabs */}
      <div className="grid grid-cols-3 gap-1.5 -mx-5 -mt-5 px-5 py-3 mb-4 border-b border-border">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "relative flex flex-col items-center gap-1 rounded-lg border px-1 py-2.5 text-center transition-colors",
              tab === t.id
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border bg-secondary/20 text-muted-foreground hover:bg-secondary/40 hover:text-foreground",
            )}
          >
            {t.recommended && (
              <span className={cn(
                "absolute -top-2 left-1/2 -translate-x-1/2 text-[9px] font-semibold rounded-full px-1.5 py-px whitespace-nowrap border transition-opacity",
                tab === t.id
                  ? "text-primary bg-primary/15 border-primary/30 opacity-100"
                  : "opacity-0",
              )}>
                Recommended
              </span>
            )}
            <span className={cn("transition-colors", tab === t.id ? "text-primary" : "")}>
              {t.icon}
            </span>
            <span className="text-[11px] font-medium leading-tight">{t.label}</span>
            <span className="text-[10px] text-muted-foreground leading-tight hidden sm:block">{t.subtitle}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === "sdk"    && <SdkContent framework={framework} setFramework={setFramework} variant={variant} setVariant={setVariant} />}
      {tab === "direct" && <DirectContent />}
      {tab === "mcp"    && <McpContent />}
    </SlidePanel>
  )
}
