export * as OmnicodeUASpoofPlugin from "./omnicode-ua-spoof.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join as joinPath } from "node:path"
import { installGlobalFetchOverride, installTorRoutingDispatcher } from "../omnicode-socks-dispatcher.js"
import { ensureTor } from "../omnicode-tor.js"
import * as OmnicodeSettings from "@opencode/util/omnicode-settings"

type Fingerprint = {
  nonce: string
  ua: string
  clientLabel: string
}

function resolveFingerprintPath(): string {
  const data = process.env.XDG_DATA_HOME || joinPath(homedir(), ".local", "share")
  return joinPath(data, "opencode", "omnicode-fingerprint.json")
}

let cachedFingerprint: Fingerprint | null = null
let cachedMtime = 0

function loadFingerprint(): Fingerprint | null {
  try {
    const file = resolveFingerprintPath()
    const stat = statSync(file)
    const mtime = stat.mtimeMs
    if (cachedFingerprint && mtime === cachedMtime) return cachedFingerprint
    const raw = readFileSync(file, "utf8")
    const parsed = JSON.parse(raw) as Partial<Fingerprint>
    if (typeof parsed.nonce !== "string" || parsed.nonce.length < 16) return null
    if (typeof parsed.ua !== "string" || !parsed.ua) return null
    if (typeof parsed.clientLabel !== "string" || !parsed.clientLabel) return null
    cachedFingerprint = {
      nonce: parsed.nonce,
      ua: parsed.ua,
      clientLabel: parsed.clientLabel,
    }
    cachedMtime = mtime
    return cachedFingerprint
  } catch {
    return null
  }
}

function deriveWireId(realID: string, nonce: string, prefix: string): string {
  const h = createHash("sha256")
  h.update(nonce)
  h.update("\u0000")
  h.update(realID)
  return `${prefix}_` + h.digest("hex")
}

const FALLBACK_UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
] as const

function pickFallbackUA(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return FALLBACK_UAS[Math.abs(h) % FALLBACK_UAS.length]
}

function isOpencodeHost(baseURL: string | undefined): boolean {
  if (!baseURL) return false
  try {
    const host = new URL(baseURL).hostname.toLowerCase()
    return host === "opencode.ai" || host.endsWith(".opencode.ai")
  } catch {
    return false
  }
}

const envBool = (name: string, fallback: boolean) => {
  const v = (process.env[name] ?? "").toLowerCase()
  if (["1", "true", "yes", "on"].includes(v)) return true
  if (["0", "false", "no", "off"].includes(v)) return false
  return fallback
}

const FALLBACK_SPOOF_SESSION = envBool("OMNICODE_SPOOF_SESSION", true)
const FALLBACK_SPOOF_UA = envBool("OMNICODE_SPOOF_UA", true)
const FALLBACK_SPOOF_CLIENT = envBool("OMNICODE_SPOOF_CLIENT", true)

function freshSessionID(): string {
  return "ses_" + randomBytes(32).toString("hex")
}

let loggedLoad = false
let loggedApply = false
let loggedApplyFingerprint = ""

export const Plugin = define({
  id: "omnicode.spoof.user-agent",
  effect: Effect.fn("OmnicodeUASpoofPlugin")(function* (ctx) {
    if (!loggedLoad) {
      loggedLoad = true
      yield* Effect.logInfo("omnicode-ua-spoof: plugin registered")
    }

    if (OmnicodeSettings.resolved().forceTor) {
      const installRes = yield* Effect.promise(() => installTorRoutingDispatcher())
      yield* Effect.logInfo("omnicode-ua-spoof: tor dispatcher install (Tor routing enabled)", installRes)
      const fetchOverride = installGlobalFetchOverride()
      yield* Effect.logInfo("omnicode-ua-spoof: global fetch override (Tor routing enabled)", fetchOverride)
    } else {
      yield* Effect.logInfo(
        "omnicode-ua-spoof: Tor routing disabled; inherited HTTPS_PROXY handles egress where configured",
      )
    }

    Effect.runFork(
      Effect.promise(() => ensureTor()).pipe(
        Effect.tap((r) => Effect.logInfo("omnicode-ua-spoof: tor bootstrap", r)),
        Effect.catchCause((c) => Effect.logInfo("omnicode-ua-spoof: tor bootstrap failed", { cause: String(c) })),
      ),
    )

    const hook = (event: SessionHooks["model.request"]) =>
      Effect.gen(function* () {
        const isOC = isOpencodeHost(event.baseURL)
        if (!isOC) return

        const fp = loadFingerprint()

        if (fp) {
          if (!loggedApply || loggedApplyFingerprint !== fp.nonce) {
            loggedApply = true
            loggedApplyFingerprint = fp.nonce
            yield* Effect.logInfo("omnicode-ua-spoof: applying fingerprint", {
              nonce: fp.nonce.slice(0, 12) + "…",
              ua: fp.ua.slice(0, 40) + "…",
              client: fp.clientLabel,
              baseURL: event.baseURL,
            })
          }

          const realSession = event.headers["x-opencode-session-id"] ?? event.sessionID ?? ""
          const realProject = event.headers["x-opencode-project"] ?? ""
          const wireSession = deriveWireId(realSession, fp.nonce, "ses")
          const wireProject = realProject ? deriveWireId(realProject, fp.nonce, "prj") : undefined

          event.headers["x-opencode-session-id"] = wireSession
          event.headers["x-session-affinity"] = wireSession
          event.headers["X-Session-Id"] = wireSession
          event.headers["x-opencode-session"] = wireSession
          delete event.headers["x-opencode-parent-session-id"]
          delete event.headers["x-parent-session-id"]
          if (wireProject) event.headers["x-opencode-project"] = wireProject
          else delete event.headers["x-opencode-project"]

          event.headers["User-Agent"] = fp.ua
          event.headers["user-agent"] = fp.ua
          event.headers["x-opencode-client"] = fp.clientLabel
          return
        }

        if (!loggedApply) {
          loggedApply = true
          yield* Effect.logInfo("omnicode-ua-spoof: NO fingerprint loaded, headers pass through", {
            fallback_spoof_session: FALLBACK_SPOOF_SESSION,
            fallback_spoof_ua: FALLBACK_SPOOF_UA,
          })
        }
        if (FALLBACK_SPOOF_SESSION) {
          const id = freshSessionID()
          event.headers["x-opencode-session-id"] = id
          event.headers["x-session-affinity"] = id
          event.headers["X-Session-Id"] = id
          event.headers["x-opencode-session"] = id
          delete event.headers["x-opencode-parent-session-id"]
          delete event.headers["x-parent-session-id"]
          delete event.headers["x-opencode-project"]
        }
        if (FALLBACK_SPOOF_CLIENT) {
          const freshClient = "oc-" + randomBytes(6).toString("hex")
          event.headers["x-opencode-client"] = freshClient
          delete event.headers["x-opencode-install-id"]
          delete event.headers["x-opencode-device-id"]
          delete event.headers["x-opencode-machine-id"]
          delete event.headers["x-opencode-hwid"]
          delete event.headers["x-install-id"]
          delete event.headers["x-device-id"]
        }
        if (FALLBACK_SPOOF_UA) {
          const ua = pickFallbackUA(event.sessionID)
          event.headers["User-Agent"] = ua
          event.headers["user-agent"] = ua
          if (!FALLBACK_SPOOF_CLIENT) delete event.headers["x-opencode-client"]
        }
      }).pipe(Effect.catch(() => Effect.void))
    yield* ctx.session.hook("model.request", hook)
  }),
})
