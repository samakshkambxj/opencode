import { Database } from "@opencode/core/database/database"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { sql } from "drizzle-orm"
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { randomBytes as nodeRandomBytes } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as os from "node:os"
import * as path from "node:path"
import { ensureTor, signalNewNym, probeExitIp } from "@opencode/core/omnicode-tor"
import { recycleTorPool } from "@opencode/core/omnicode-socks-dispatcher"
import { OmnicodeAbliterated } from "@opencode/core/omnicode-abliterated"

const PREFLIGHT_HEADERS = {
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
}

const preflight = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const origin = request.headers.origin
  return HttpServerResponse.empty({
    status: 204,
    headers: origin
      ? {
          ...PREFLIGHT_HEADERS,
          "access-control-allow-origin": origin,
          vary: "origin",
        }
      : PREFLIGHT_HEADERS,
  })
})

export const omnicodePreflight = preflight

export const OmnicodeResetLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("OPTIONS", "/_omnicode/export-sessions", preflight)
    yield* router.add("OPTIONS", "/_omnicode/reset-limits", preflight)
    yield* router.add("OPTIONS", "/_omnicode/abliterated", preflight)
    yield* router.add("OPTIONS", "/_omnicode/abliterated/content", preflight)
    yield* router.add(
      "GET",
      "/_omnicode/abliterated/content",
      Effect.gen(function* () {
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          enabled: OmnicodeAbliterated.enabled(),
          custom: OmnicodeAbliterated.custom(),
          content: OmnicodeAbliterated.content(),
          default: OmnicodeAbliterated.DefaultContent,
          max: OmnicodeAbliterated.MaxContentLength,
        })
      }),
    )
    yield* router.add(
      "POST",
      "/_omnicode/abliterated/content",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const parsed = yield* Effect.result(request.json)
        if (parsed._tag === "Failure")
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "invalid JSON body" }, { status: 400 })
        const body = parsed.success
        const reset = body !== null && typeof body === "object" && "reset" in body && body.reset === true
        const content =
          body && typeof body === "object" && "content" in body && typeof body.content === "string"
            ? body.content
            : undefined
        if (!reset && content === undefined)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "content or reset is required" }, { status: 400 })
        if (content !== undefined && content.length > OmnicodeAbliterated.MaxContentLength)
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `content exceeds ${OmnicodeAbliterated.MaxContentLength} characters` },
            { status: 413 },
          )
        const result = yield* Effect.result(
          Effect.try({
            try: () => (reset ? OmnicodeAbliterated.resetContent() : OmnicodeAbliterated.setContent(content ?? "")),
            catch: (cause) => cause,
          }),
        )
        if (result._tag === "Failure")
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `could not write instructions: ${String(result.failure)}` },
            { status: 500 },
          )
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          custom: OmnicodeAbliterated.custom(),
          length: OmnicodeAbliterated.content().length,
        })
      }),
    )
    yield* router.add(
      "GET",
      "/_omnicode/abliterated",
      Effect.gen(function* () {
        return HttpServerResponse.jsonUnsafe({ ok: true, enabled: OmnicodeAbliterated.enabled() })
      }),
    )
    yield* router.add(
      "POST",
      "/_omnicode/abliterated",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const enabled = url.searchParams.get("enabled") === "1"
        const result = yield* Effect.result(
          Effect.try({
            try: () => OmnicodeAbliterated.setEnabled(enabled),
            catch: (cause) => cause,
          }),
        )
        if (result._tag === "Failure") {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `could not write setting: ${String(result.failure)}` },
            { status: 500 },
          )
        }
        return HttpServerResponse.jsonUnsafe({ ok: true, enabled })
      }),
    )
    yield* router.add(
      "POST",
      "/_omnicode/export-sessions",
      Effect.gen(function* () {
        const service = yield* Database.Service
        const backupsDir = resolveBackupsDir()
        try {
          mkdirSync(backupsDir, { recursive: true })
        } catch (e) {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `cannot create backup dir: ${(e as Error).message}` },
            { status: 500 },
          )
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-")
        const dest = path.join(backupsDir, `sessions-${stamp}.db`)
        const escaped = dest.replace(/'/g, "''")
        const vacuum = yield* Effect.result(service.db.run(sql.raw(`VACUUM INTO '${escaped}'`)))
        if (vacuum._tag === "Failure") {
          const message = vacuum.failure instanceof Error ? vacuum.failure.message : String(vacuum.failure)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: `vacuum failed: ${message}` }, { status: 500 })
        }
        let bytes = 0
        try {
          bytes = statSync(dest).size
        } catch {}
        return HttpServerResponse.jsonUnsafe({ ok: true, path: dest, bytes })
      }),
    )
    yield* router.add(
      "POST",
      "/_omnicode/reset-limits",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const mode = url.searchParams.get("mode")
        const deep = url.searchParams.get("deep") === "1" || mode === "fresh" || mode === "fast" || mode === "deep"
        const nukeCredentials = url.searchParams.get("nuke-credentials") === "1"
        diagWrite(`[reset] start mode=${mode ?? "default"} deep=${deep}`)

        const serviceResult = yield* Effect.result(Database.Service)
        if (serviceResult._tag === "Failure") {
          return HttpServerResponse.jsonUnsafe({
            ok: false,
            mode: mode || "default",
            error: `database unavailable: ${(serviceResult.failure as Error)?.message ?? String(serviceResult.failure)}`,
          })
        }
        const service = serviceResult.success

        if (!deep) {
          yield* service.db.run(
            sql`UPDATE session_v2
                   SET cost = 0,
                       tokens_input = 0,
                       tokens_output = 0,
                       tokens_reasoning = 0,
                       tokens_cache_read = 0,
                       tokens_cache_write = 0`,
          )
          yield* service.db.run(
            sql`DELETE FROM event
                   WHERE type IN (
                     'session.step.ended@1', 'session.step.ended@2',
                     'session.step.failed@1', 'session.step.failed@2',
                     'session.usage.recorded@1'
                   )`,
          )
          return HttpServerResponse.jsonUnsafe({ ok: true, deep: false })
        }

        const fingerprint = rotateFingerprint()
        if ("error" in fingerprint) {
          return HttpServerResponse.jsonUnsafe(
            {
              ok: false,
              mode: "fresh",
              error: `fingerprint rotation failed: ${fingerprint.error}`,
              stage: "rotateFingerprint",
            },
            { status: 500 },
          )
        }

        const wipeTargets = [
          "session_part",
          "session_message",
          "session_inbox",
          "instruction_entry",
          "instruction_state",
          "instruction_blob",
          "permission",
          ...(nukeCredentials ? (["credential"] as const) : []),
          "event",
          "event_sequence",
          "kv",
          "session_v2",
          "project_directory",
          "project",
        ] as const
        const wipeSkipped: string[] = []
        const wipeFailed: { table: string; error: string }[] = []
        for (const table of wipeTargets) {
          const outcome = yield* Effect.result(service.db.run(sql.raw(`DELETE FROM ${table}`)))
          if (outcome._tag === "Success") continue
          const msg = outcome.failure instanceof Error ? outcome.failure.message : String(outcome.failure)
          if (/no such table/i.test(msg)) {
            wipeSkipped.push(table)
            continue
          }
          wipeFailed.push({ table, error: msg })
        }
        if (wipeFailed.length > 0) {
          diagWrite(`[reset] wipe FAILED: ${wipeFailed.map((f) => `${f.table}=${f.error}`).join("; ")}`)
          return HttpServerResponse.jsonUnsafe(
            {
              ok: false,
              mode: "fresh",
              error: `wipe failed on ${wipeFailed.length} table(s): ${wipeFailed
                .map((f) => `${f.table}: ${f.error}`)
                .join("; ")}`,
              wipe_skipped: wipeSkipped,
              wipe_failed: wipeFailed,
              fingerprint_rotated: true,
              fingerprint_client: fingerprint.clientLabel,
            },
            { status: 500 },
          )
        }

        const checkpointResult = yield* Effect.result(service.db.run(sql.raw(`PRAGMA wal_checkpoint(TRUNCATE)`)))
        if (checkpointResult._tag === "Failure") {
          const msg =
            checkpointResult.failure instanceof Error
              ? checkpointResult.failure.message
              : String(checkpointResult.failure)
          console.warn(`[omnicode-reset] wal_checkpoint failed: ${msg}`)
          diagWrite(`[reset] wal_checkpoint FAILED: ${msg}`)
        } else {
          diagWrite("[reset] wal_checkpoint TRUNCATE ok")
        }

        const warp = yield* rotateWarp()
        diagWrite(`[reset] done warp=${warp.status}`)

        return HttpServerResponse.jsonUnsafe({
          ok: true,
          mode: "fresh",
          deep: true,
          kept_credentials: !nukeCredentials,
          wipe_skipped: wipeSkipped,
          wipe_failed: [],
          fingerprint_rotated: true,
          fingerprint_client: fingerprint.clientLabel,
          fingerprint_nonce_prefix: fingerprint.nonce.slice(0, 12),
          warp,
        })
      }).pipe(
        Effect.catchCause((cause) => {
          console.error("[omnicode-reset] uncaught in handler:", cause)
          const pretty =
            typeof cause === "object" && cause !== null && "toString" in cause
              ? (cause as { toString(): string }).toString()
              : String(cause)
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe({
              ok: false,
              handler_error: pretty.slice(0, 512),
              error: "reset failed before completion — see server log",
            }),
          )
        }),
      ),
    )
  }),
)

function resolveBackupsDir(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "session-backups")
}

function fingerprintPath(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "omnicode-fingerprint.json")
}

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
] as const

function resetDiagPath(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "log", "omnicode-diag.log")
}

function diagWrite(line: string): void {
  try {
    const p = resetDiagPath()
    mkdirSync(path.dirname(p), { recursive: true })
    appendFileSync(p, `${new Date().toISOString()} ${line}\n`, { encoding: "utf8" })
  } catch {
    /* swallow — diag write failures must not stop the reset */
  }
}

function rotateFingerprint(): { nonce: string; ua: string; clientLabel: string; file: string } | { error: string } {
  const file = fingerprintPath()
  try {
    const nonce = nodeRandomBytes(32).toString("hex")
    const uaIdx = nodeRandomBytes(1)[0] % UA_POOL.length
    const ua = UA_POOL[uaIdx]
    const clientLabel = "oc-" + nodeRandomBytes(6).toString("hex")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ nonce, ua, clientLabel, stamped: Date.now() }), { encoding: "utf8" })
    const st = statSync(file)
    diagWrite(
      `[reset-fingerprint] rotated ok nonce=${nonce.slice(0, 12)}… client=${clientLabel} ` +
        `ua="${ua.slice(0, 40)}…" file=${file} size=${st.size}`,
    )
    return { nonce, ua, clientLabel, file }
  } catch (e) {
    const err = (e as Error)?.message ?? String(e)
    diagWrite(`[reset-fingerprint] FAILED file=${file} error=${err}`)
    return { error: err }
  }
}

type WarpOutcome =
  | { status: "rotated"; mode: "tor"; ip_before: string | null; ip_after: string }
  | { status: "unverified"; mode: "tor"; ip_before: null; ip_after: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; step: string; error: string; ip_before?: string | null }

export function rotateWarp(): Effect.Effect<WarpOutcome & { warp_cycle?: WarpCycleOutcome }> {
  return Effect.promise(async (): Promise<WarpOutcome & { warp_cycle?: WarpCycleOutcome }> => {
    const [torResult, warpCycle] = await Promise.all([doTorRotation(), doWarpCycle()])
    return { ...finalizeDisplay(torResult), warp_cycle: warpCycle }
  })
}

function finalizeDisplay(outcome: WarpOutcome): WarpOutcome {
  return outcome
}

async function doTorRotation(): Promise<WarpOutcome> {
  const ensured = await ensureTor()
  if (ensured.status !== "ready") {
    return { status: "skipped", reason: `tor not ready: ${ensured.reason}` }
  }

  const ipBefore = await probeExitIp(15_000)

  const nym = await signalNewNym()
  if (!nym.ok) {
    return { status: "failed", step: "newnym", error: nym.response, ip_before: ipBefore }
  }

  await new Promise((r) => setTimeout(r, 8_000))
  await recycleTorPool()

  let ipAfter = await probeExitIp(15_000)

  for (let attempt = 0; attempt < 2 && ipAfter && ipBefore && ipAfter === ipBefore; attempt++) {
    const retry = await signalNewNym()
    if (!retry.ok) break
    await new Promise((r) => setTimeout(r, 8_000))
    await recycleTorPool()
    ipAfter = await probeExitIp(15_000)
  }

  if (!ipAfter) {
    return { status: "failed", step: "probe-after", error: "could not read tor exit IP", ip_before: ipBefore }
  }
  if (!ipBefore) {
    return { status: "unverified", mode: "tor", ip_before: null, ip_after: ipAfter }
  }
  if (ipBefore === ipAfter) {
    return {
      status: "failed",
      step: "same-ip",
      error: `tor returned the same exit (${ipAfter}) after 3 NEWNYMs`,
      ip_before: ipBefore,
    }
  }
  return { status: "rotated", mode: "tor", ip_before: ipBefore, ip_after: ipAfter }
}

type WarpCycleOutcome =
  | { status: "rotated"; ip_before: string; ip_after: string }
  | { status: "same_ip"; ip: string }
  | { status: "unverified"; ip_before: string | null; ip_after: string | null }
  | { status: "skipped"; reason: string }
  | { status: "failed"; step: string; error: string }

const execFileAsync = promisify(execFile)

function resolveWarpCli(): string | undefined {
  for (const c of WARP_CANDIDATES) if (existsSync(c)) return c
  return undefined
}

async function fetchDirectEgressIp(timeoutMs = 4000): Promise<string | null> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch("https://1.1.1.1/cdn-cgi/trace", { signal: controller.signal })
    const text = await res.text()
    const m = /\bip=([0-9a-fA-F:.]+)/.exec(text)
    return m ? m[1] : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function doWarpCycle(): Promise<WarpCycleOutcome> {
  const warp = resolveWarpCli()
  if (!warp) return { status: "skipped", reason: "warp-cli not installed" }

  const ipBefore = await fetchDirectEgressIp()

  const run = async (step: string, args: string[], tolerate = false): Promise<void> => {
    try {
      await execFileAsync(warp, ["--accept-tos", ...args], {
        windowsHide: true,
        timeout: 20_000,
      })
    } catch (e) {
      if (!tolerate) throw new Error(`${step}: ${(e as Error).message}`)
    }
  }

  try {
    await run("disconnect", ["disconnect"], true)
    await run("rotate-keys", ["tunnel", "rotate-keys"])
    await run("connect", ["connect"])

    await new Promise((r) => setTimeout(r, 4_000))

    const ipAfter = await fetchDirectEgressIp()
    if (!ipAfter) {
      return { status: "unverified", ip_before: ipBefore, ip_after: null }
    }
    if (!ipBefore) {
      return { status: "unverified", ip_before: null, ip_after: ipAfter }
    }
    if (ipBefore === ipAfter) {
      return { status: "same_ip", ip: ipAfter }
    }
    return { status: "rotated", ip_before: ipBefore, ip_after: ipAfter }
  } catch (e) {
    return { status: "failed", step: "warp-cycle", error: (e as Error).message }
  }
}

const WARP_CANDIDATES = [
  "/usr/bin/warp-cli",
  "/usr/local/bin/warp-cli",
  "/opt/homebrew/bin/warp-cli",
]
