export * as OmnicodeAutoRotatePlugin from "./omnicode-auto-rotate.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { findWarp } from "@opencode/util/omnicode-dependencies"
import * as OmnicodeSettings from "@opencode/util/omnicode-settings"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { dirname as pathDirname, join as pathJoin } from "node:path"

function fingerprintPath(): string {
  const data = process.env.XDG_DATA_HOME || pathJoin(homedir(), ".local", "share")
  return pathJoin(data, "opencode", "omnicode-fingerprint.json")
}

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
] as const

function rotateFingerprintFile(): void {
  try {
    const nonce = randomBytes(32).toString("hex")
    const uaIdx = randomBytes(1)[0] % UA_POOL.length
    const ua = UA_POOL[uaIdx]
    const clientLabel = "oc-" + randomBytes(6).toString("hex")
    const file = fingerprintPath()
    mkdirSync(pathDirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ nonce, ua, clientLabel, stamped: Date.now() }), { encoding: "utf8" })
  } catch {
    /* non-fatal; next request keeps using the previous fingerprint */
  }
}

const rotationHistory: number[] = []
let rotationInFlight: Promise<void> | undefined

function allowRotation(maxPerHour: number): boolean {
  const cutoff = Date.now() - 3600_000
  while (rotationHistory.length && rotationHistory[0] < cutoff) rotationHistory.shift()
  return rotationHistory.length < maxPerHour
}

function doRotation(): Promise<void> {
  if (rotationInFlight) return rotationInFlight
  rotationInFlight = new Promise<void>((resolve) => {
    rotationHistory.push(Date.now())
    rotateFingerprintFile()
    const warp = findWarp()
    if (!warp) {
      resolve()
      return
    }
    const run = (args: string[]) =>
      new Promise<void>((done) => {
        const c = spawn(warp, args, { stdio: "ignore", windowsHide: true })
        c.on("exit", () => done())
        c.on("error", () => done())
        setTimeout(done, 4000)
      })
    ;(async () => {
      await run(["--accept-tos", "registration", "delete"])
      await run(["--accept-tos", "registration", "new"])
      await new Promise((r) => setTimeout(r, 1500))
      resolve()
    })()
  }).finally(() => {
    rotationInFlight = undefined
  })
  return rotationInFlight
}

function isOpencodeURL(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return h === "opencode.ai" || h.endsWith(".opencode.ai")
  } catch {
    return false
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    const clone = response.clone()
    return await clone.text()
  } catch {
    return ""
  }
}

const QUOTA_BODY = /FreeUsageLimit|BudgetLimit|GoUsageLimit|usage limit|limit reached/i

export const Plugin = define({
  id: "omnicode.auto-rotate",
  effect: Effect.fn("OmnicodeAutoRotatePlugin")(function* (ctx) {
    const hook = (event: SessionHooks["http.response"]) =>
      Effect.gen(function* () {
        if (!isOpencodeURL(event.request.url)) return
        const status = event.response.status
        if (status !== 429 && status !== 403) return

        const body = yield* Effect.promise(() => readBody(event.response))
        if (!QUOTA_BODY.test(body)) return

        const settings = OmnicodeSettings.resolved()
        if (!settings.autoRotate) return
        if (!allowRotation(settings.autoRotateMaxPerHour)) return

        void doRotation()
      }).pipe(Effect.catch(() => Effect.void))

    yield* ctx.session.hook("http.response", hook)
  }),
})
