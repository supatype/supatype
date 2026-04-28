import React, { useState } from "react"
import { Button, Card, Input } from "../../components/ui.js"

export function ConfigurationView(): React.ReactElement {
  const [jwtExpiry, setJwtExpiry] = useState(3600)
  const [siteUrl, setSiteUrl] = useState("")
  const [redirectUrls, setRedirectUrls] = useState("")
  const [emailConfirm, setEmailConfirm] = useState(false)
  const [autoConfirm, setAutoConfirm] = useState(false)
  const [sessionTimeout, setSessionTimeout] = useState(0)
  const [emailRateLimit, setEmailRateLimit] = useState(4)
  const [otpExpiry, setOtpExpiry] = useState(3600)
  const [captchaEnabled, setCaptchaEnabled] = useState(false)
  const [captchaKey, setCaptchaKey] = useState("")
  const [disableSignup, setDisableSignup] = useState(false)
  const [saved, setSaved] = useState(false)

  function handleSave() {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="space-y-5 max-w-2xl">
      <h1 className="text-xl font-semibold text-foreground">Configuration</h1>

      <Card className="p-4 space-y-4">
        <h3 className="text-sm font-medium text-foreground">JWT Settings</h3>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">JWT Expiry (seconds)</label>
          <Input type="number" className="w-40" value={jwtExpiry} onChange={(e) => setJwtExpiry(Number(e.target.value))} />
        </div>
      </Card>

      <Card className="p-4 space-y-4">
        <h3 className="text-sm font-medium text-foreground">URL Configuration</h3>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Site URL</label>
          <Input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://yourapp.com" />
          <p className="text-xs text-muted-foreground mt-1">Used for email templates and OAuth redirect URLs.</p>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Additional redirect URLs (one per line)</label>
          <textarea
            className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-sm font-mono focus:outline-none min-h-[80px] resize-y"
            value={redirectUrls}
            onChange={(e) => setRedirectUrls(e.target.value)}
            placeholder="https://yourapp.com/callback"
          />
        </div>
      </Card>

      <Card className="p-4 space-y-4">
        <h3 className="text-sm font-medium text-foreground">Sessions</h3>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Session timeout (seconds, 0 = no timeout)</label>
          <Input type="number" className="w-40" value={sessionTimeout} onChange={(e) => setSessionTimeout(Number(e.target.value))} />
        </div>
      </Card>

      <Card className="p-4 space-y-4">
        <h3 className="text-sm font-medium text-foreground">Email</h3>
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={emailConfirm} onChange={(e) => setEmailConfirm(e.target.checked)} />
            Require email confirmation on signup
          </label>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Max emails per hour</label>
            <Input type="number" className="w-32" value={emailRateLimit} onChange={(e) => setEmailRateLimit(Number(e.target.value))} />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">OTP expiry (seconds)</label>
            <Input type="number" className="w-40" value={otpExpiry} onChange={(e) => setOtpExpiry(Number(e.target.value))} />
          </div>
        </div>
      </Card>

      <Card className="p-4 space-y-4">
        <h3 className="text-sm font-medium text-foreground">Attack Protection</h3>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={captchaEnabled} onChange={(e) => setCaptchaEnabled(e.target.checked)} />
          Enable CAPTCHA
        </label>
        {captchaEnabled && (
          <div>
            <label className="block text-xs text-muted-foreground mb-1">hCaptcha / Turnstile site key</label>
            <Input value={captchaKey} onChange={(e) => setCaptchaKey(e.target.value)} placeholder="Site key" />
          </div>
        )}
      </Card>

      <Card className="p-4 space-y-4">
        <h3 className="text-sm font-medium text-foreground">Advanced</h3>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} />
          Auto-confirm in development mode
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={disableSignup} onChange={(e) => setDisableSignup(e.target.checked)} />
          Disable new user signups
        </label>
      </Card>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={handleSave}>Save configuration</Button>
        {saved && <span className="text-xs text-emerald-500">Saved</span>}
      </div>
    </div>
  )
}
