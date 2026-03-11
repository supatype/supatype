import React, { useState } from "react"
import { useStudioClient } from "../StudioApp.js"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, Input, Th } from "../components/ui.js"

export function Settings(): React.ReactElement {
  const client = useStudioClient()
  const [activeTab, setActiveTab] = useState<"general" | "keys" | "env" | "danger">("general")

  return (
    <>
      <div className="flex border-b border-border mb-4">
        {(["general", "keys", "env", "danger"] as const).map((tab) => (
          <button
            key={tab}
            className={cn(
              "px-4 py-2 text-sm border-b-2 transition-colors",
              activeTab === tab
                ? "text-primary border-primary"
                : "text-muted-foreground border-transparent hover:text-foreground"
            )}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "general" ? "General" : tab === "keys" ? "API Keys" : tab === "env" ? "Environment" : "Danger Zone"}
          </button>
        ))}
      </div>

      {activeTab === "general" ? <GeneralSettings /> : null}
      {activeTab === "keys" ? <ApiKeysSettings /> : null}
      {activeTab === "env" ? <EnvSettings /> : null}
      {activeTab === "danger" ? <DangerZone /> : null}
    </>
  )
}

function GeneralSettings(): React.ReactElement {
  const [projectName, setProjectName] = useState("my-project")
  const [siteUrl, setSiteUrl] = useState("http://localhost:3000")

  return (
    <Card className="p-4">
      <h3>Project Configuration</h3>
      <div className="flex flex-col gap-4 max-w-[500px] mt-4">
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Project Name</label>
          <Input value={projectName} onChange={(e) => setProjectName(e.target.value)} />
        </div>
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Site URL</label>
          <Input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} />
        </div>
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Database URL</label>
          <Input className="text-muted-foreground" value="postgresql://postgres:postgres@localhost:5432/my-project" readOnly />
        </div>
        <Button variant="primary" className="self-start">Save Changes</Button>
      </div>
    </Card>
  )
}

function ApiKeysSettings(): React.ReactElement {
  const [showKeys, setShowKeys] = useState(false)
  const anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxODAwMDAwMDAwfQ.xxx"
  const serviceKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE4MDAwMDAwMDB9.yyy"

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text)
  }

  return (
    <Card className="p-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="m-0">API Keys</h3>
        <Button onClick={() => setShowKeys(!showKeys)}>
          {showKeys ? "Hide Keys" : "Show Keys"}
        </Button>
      </div>

      <div className="flex flex-col gap-5">
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">
            anon (public)
            <Badge className="ml-2">safe for client</Badge>
          </label>
          <div className="flex gap-2">
            <Input
              className="flex-1 font-mono"
              value={showKeys ? anonKey : "\u2022".repeat(40)}
              readOnly
            />
            <Button onClick={() => copyToClipboard(anonKey)}>Copy</Button>
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Use in browser. Row-level security policies protect data.
          </p>
        </div>

        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">
            service_role (secret)
            <Badge variant="red" className="ml-2">server only</Badge>
          </label>
          <div className="flex gap-2">
            <Input
              className="flex-1 font-mono"
              value={showKeys ? serviceKey : "\u2022".repeat(40)}
              readOnly
            />
            <Button onClick={() => copyToClipboard(serviceKey)}>Copy</Button>
          </div>
          <p className="text-xs text-zinc-600 mt-1">
            Bypasses RLS. Never expose in client code.
          </p>
        </div>
      </div>
    </Card>
  )
}

function EnvSettings(): React.ReactElement {
  const envVars = [
    { key: "DATABASE_URL", value: "postgresql://postgres:postgres@localhost:5432/my-project", sensitive: true },
    { key: "JWT_SECRET", value: "super-secret-jwt-token-change-in-production", sensitive: true },
    { key: "SITE_URL", value: "http://localhost:3000", sensitive: false },
    { key: "GOTRUE_MAILER_AUTOCONFIRM", value: "true", sensitive: false },
    { key: "S3_ENDPOINT", value: "http://localhost:9000", sensitive: false },
    { key: "S3_ACCESS_KEY", value: "supatype", sensitive: true },
    { key: "S3_SECRET_KEY", value: "supatype-secret", sensitive: true },
  ]

  return (
    <Card className="p-4">
      <h3>Environment Variables</h3>
      <p className="text-[0.8rem] text-muted-foreground mb-4">
        These are read from your project's .env file.
      </p>
      <Card className="overflow-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <Th>Key</Th>
              <Th>Value</Th>
            </tr>
          </thead>
          <tbody>
            {envVars.map((v) => (
              <tr key={v.key} className="border-b border-border hover:bg-accent/50">
                <td className="px-3 py-2 text-sm"><code className="text-primary">{v.key}</code></td>
                <td className="px-3 py-2 font-mono text-xs">
                  {v.sensitive ? <span className="text-zinc-600">{"\u2022".repeat(20)}</span> : v.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Card>
  )
}

function DangerZone(): React.ReactElement {
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div className="rounded-lg border border-destructive bg-card p-4">
      <h3 className="text-red-400">Danger Zone</h3>
      <p className="text-[0.8rem] text-muted-foreground mb-6">
        These actions are irreversible. Proceed with caution.
      </p>

      <div className="flex flex-col gap-5">
        <div className="flex justify-between items-center p-4 border border-border rounded-md">
          <div>
            <div className="font-medium mb-1">Reset Database</div>
            <div className="text-xs text-muted-foreground">Drop all tables and re-apply migrations from scratch</div>
          </div>
          {!confirmReset ? (
            <Button variant="destructive" onClick={() => setConfirmReset(true)}>Reset</Button>
          ) : (
            <div className="flex gap-2">
              <Button variant="destructive">Confirm Reset</Button>
              <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
            </div>
          )}
        </div>

        <div className="flex justify-between items-center p-4 border border-border rounded-md">
          <div>
            <div className="font-medium mb-1">Delete Project</div>
            <div className="text-xs text-muted-foreground">Permanently delete this project and all associated data</div>
          </div>
          {!confirmDelete ? (
            <Button variant="destructive" onClick={() => setConfirmDelete(true)}>Delete</Button>
          ) : (
            <div className="flex gap-2">
              <Button variant="destructive">Confirm Delete</Button>
              <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
