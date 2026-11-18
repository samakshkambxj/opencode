export * as OmnicodeImpersonateFetch from "./omnicode-impersonate-fetch.js"

import { spawn, execFile } from "node:child_process"
import { appendFileSync, mkdirSync, statSync } from "node:fs"
import { writeFile, unlink } from "node:fs/promises"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { dirname as pathDirname, join as pathJoin, resolve as pathResolve } from "node:path"
import * as OmnicodeSettings from "./omnicode-settings.js"

let nativeFetch = globalThis.fetch.bind(globalThis)

const DIAG_PATH = (() => {
  const data = process.env.XDG_DATA_HOME || pathJoin(homedir(), ".local", "share")
  return pathJoin(data, "opencode", "log", "omnicode-diag.log")
})()
let diagDirOk = false
function diag(line: string): void {
  try {
    if (!diagDirOk) {
      mkdirSync(pathDirname(DIAG_PATH), { recursive: true })
      diagDirOk = true
    }
    appendFileSync(DIAG_PATH, `${new Date().toISOString()} ${line}\n`, { encoding: "utf8" })
  } catch { /* ignore */ }
}

let _cachedBin: string | null | undefined

function resolveImpersonateBin(): string | null {
  if (_cachedBin !== undefined) return _cachedBin
  const configured = process.env.OMNICODE_CURL_IMPERSONATE
  if (configured !== undefined) {
    if (configured === "" || configured === "0" || configured.toLowerCase() === "none") {
      _cachedBin = null
      diag(`[impersonate] disabled by OMNICODE_CURL_IMPERSONATE — using native fetch + free fallback`)
      return null
    }
    try {
      statSync(configured)
      _cachedBin = configured
      diag(`[impersonate] binary resolved from OMNICODE_CURL_IMPERSONATE at ${configured}`)
      return configured
    } catch {
      diag(`[impersonate] OMNICODE_CURL_IMPERSONATE does not exist at ${configured} — using native fetch`)
      _cachedBin = null
      return null
    }
  }
  try {
    let dir = pathResolve(pathDirname(process.execPath))
    for (let i = 0; i < 6; i++) {
      const binary = process.platform === "win32" ? "curl-impersonate.exe" : "curl-impersonate"
      const candidate = pathJoin(dir, "deps", "impersonate", binary)
      try {
        statSync(candidate)
        _cachedBin = candidate
        diag(`[impersonate] binary resolved at ${candidate}`)
        return candidate
      } catch {
        /* keep walking */
      }
      const parent = pathDirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch (e) {
    diag(`[impersonate] resolver error: ${(e as Error).message}`)
  }
  _cachedBin = null
  diag(`[impersonate] binary NOT found — falling back to native fetch`)
  return null
}

const PROFILE_POOL = [
  "chrome131",
  "chrome136",
  "chrome133a",
  "firefox133",
  "firefox135",
  "safari180",
  "edge101",
] as const
type Profile = (typeof PROFILE_POOL)[number]

function pickProfile(seed: string): Profile {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return PROFILE_POOL[Math.abs(h) % PROFILE_POOL.length]
}

function activeNonce(): string {
  try {
    const data = process.env.XDG_DATA_HOME || pathJoin(homedir(), ".local", "share")
    const fp = pathJoin(data, "opencode", "omnicode-fingerprint.json")
    const raw = require("node:fs").readFileSync(fp, "utf8") as string
    const parsed = JSON.parse(raw) as { nonce?: string }
    if (typeof parsed.nonce === "string" && parsed.nonce.length >= 16) return parsed.nonce
  } catch { /* fall through */ }
  return String(Date.now())
}

let _activeProfile: Profile | null = null
function currentProfile(): Profile {
  if (!_activeProfile) {
    _activeProfile = pickProfile(activeNonce())
    diag(`[impersonate] profile selected: ${_activeProfile}`)
  }
  return _activeProfile
}

function isOpencodeHost(hostname: string | undefined): boolean {
  if (!hostname) return false
  const h = hostname.toLowerCase()
  return h === "opencode.ai" || h.endsWith(".opencode.ai")
}

function toHeaderPairs(h: HeadersInit | undefined): [string, string][] {
  if (!h) return []
  if (h instanceof Headers) {
    const out: [string, string][] = []
    h.forEach((v, k) => out.push([k, v]))
    return out
  }
  if (Array.isArray(h)) return h.map(([k, v]) => [String(k), String(v)])
  return Object.entries(h as Record<string, string>).map(([k, v]) => [k, String(v)])
}

async function bodyToBuffer(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (body == null) return null
  if (typeof body === "string") return Buffer.from(body, "utf8")
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (body instanceof Buffer) return body
  try {
    const ab = await new Response(body as BodyInit).arrayBuffer()
    return Buffer.from(ab)
  } catch (e) {
    diag(`[impersonate] body coercion failed: ${(e as Error).message}`)
    return null
  }
}

type ResponseHead = { status: number; statusText: string; headers: [string, string][]; bodyOffset: number }

export function parseResponseHead(out: Buffer, proxy = false): ResponseHead | null {
  let offset = 0
  while (offset < out.length) {
    let split = out.indexOf("\r\n\r\n", offset)
    let sepLen = 4
    if (split < 0) {
      split = out.indexOf("\n\n", offset)
      sepLen = 2
    }
    if (split < 0) return null
    const headPart = out.subarray(offset, split).toString("utf8")
    const lines = headPart.split(/\r?\n/)
    let statusLineIdx = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^HTTP\/[\d.]+\s+\d{3}/.test(lines[i])) {
        statusLineIdx = i
        break
      }
    }
    if (statusLineIdx < 0) return null
    const statusLine = lines[statusLineIdx]
    const match = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine)
    if (!match) return null
    const status = parseInt(match[1], 10)
    const statusText = (match[2] ?? "").trim()
    const hasContentType = lines.some((line) => /^content-type\s*:/i.test(line))
    const followedByStatus = /^HTTP\//.test(out.subarray(split + sepLen, split + sepLen + 5).toString("ascii"))
    if (
      (status >= 100 && status < 200) ||
      /connection established/i.test(statusText) ||
      (proxy && status >= 200 && status < 300 && !hasContentType && followedByStatus)
    ) {
      offset = split + sepLen
      continue
    }
    const headers: [string, string][] = []
    for (let i = statusLineIdx + 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      const colon = line.indexOf(":")
      if (colon <= 0) continue
      const k = line.slice(0, colon).trim()
      const v = line.slice(colon + 1).trim()
      const kl = k.toLowerCase()
      if (kl === "content-encoding" || kl === "transfer-encoding" || kl === "content-length" || kl === "connection")
        continue
      headers.push([k, v])
    }
    return { status, statusText, headers, bodyOffset: split + sepLen }
  }
  return null
}

const OCR_SCRIPT = `
param([string]$Path)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, $type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $task.Wait(); $task.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { exit 3 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$result.Text
`

const ocrCache = new Map<string, string>()
let ocrScriptPath: Promise<string> | undefined

function ensureOcrScript() {
  ocrScriptPath ??= (async () => {
    const file = pathJoin(tmpdir(), "omnicode-win-ocr.ps1")
    await writeFile(file, OCR_SCRIPT, "utf8")
    return file
  })()
  return ocrScriptPath
}

function runOcr(script: string, image: string) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", image],
      { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })
}

async function ocrImage(data: Buffer) {
  if (process.platform !== "win32" || data.length === 0) return undefined
  const hash = createHash("sha256").update(data).digest("hex")
  const cached = ocrCache.get(hash)
  if (cached !== undefined) return cached || undefined
  const image = pathJoin(tmpdir(), `omnicode-ocr-${process.pid}-${hash.slice(0, 12)}.png`)
  try {
    const script = await ensureOcrScript()
    await writeFile(image, data)
    const text = (await runOcr(script, image)).trim()
    ocrCache.set(hash, text)
    return text || undefined
  } catch (error) {
    diag(`[fallback] OCR failed: ${(error as Error).message}`)
    ocrCache.set(hash, "")
    return undefined
  } finally {
    await unlink(image).catch(() => undefined)
  }
}

function imageBytes(part: Record<string, unknown>) {
  const url = (part.image_url as { url?: unknown } | undefined)?.url
  if (typeof url === "string" && url.startsWith("data:")) {
    const comma = url.indexOf(",")
    if (comma >= 0 && /;base64/i.test(url.slice(5, comma))) return Buffer.from(url.slice(comma + 1), "base64")
  }
  const file = part.file as { file_data?: unknown; mime_type?: unknown } | undefined
  if (typeof file?.file_data === "string") return Buffer.from(file.file_data, "base64")
  return undefined
}

async function fallbackMessages(messages: unknown[], allowImages: boolean) {
  return Promise.all(
    messages.map(async (message) => {
      if (!message || typeof message !== "object" || !("content" in message)) return message
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) return message
      const parts = await Promise.all(
        content.map(async (part) => {
          if (!part || typeof part !== "object") return [part]
          const value = part as Record<string, unknown>
          const type = value.type
          const file = value.file as { mime_type?: unknown } | undefined
          const mime =
            typeof file?.mime_type === "string"
              ? file.mime_type
              : typeof value.mime === "string"
                ? value.mime
                : undefined
          const image =
            type === "image_url" ||
            type === "image" ||
            type === "input_image" ||
            (typeof mime === "string" && mime.startsWith("image/"))
          const media =
            image ||
            type === "file" ||
            type === "media" ||
            type === "input_file" ||
            (typeof mime === "string" && mime !== "text/plain")
          if (!media) return [part]
          if (image && allowImages) return [part]
          if (!image) {
            return [
              {
                type: "text",
                text: `[attachment omitted: ${mime ?? String(type)}; the fallback model is text-only]`,
              },
            ]
          }
          const bytes = imageBytes(value)
          const text = bytes === undefined ? undefined : await ocrImage(bytes)
          diag(
            `[fallback] media part type=${String(type)} mime=${mime ?? "n/a"} bytes=${bytes?.length ?? 0} ocr=${text?.length ?? 0}`,
          )
          return [
            {
              type: "text",
              text: text ? `[image text]\n${text}` : "[image omitted: the fallback model does not accept images and OCR found no text]",
            },
          ]
        }),
      )
      return { ...message, content: parts.flat() }
    }),
  )
}

const FALLBACK_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "shell",
  "list",
  "patch",
  "todowrite",
  "todoread",
])

const truncateText = (text: string, max = 4000) => (text.length > max ? `${text.slice(0, max)}\n[truncated]` : text)

const textOf = (content: unknown) => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n")
}

const compactMessage = (message: unknown, max = 4000) => {
  if (!message || typeof message !== "object") return message
  const value = message as Record<string, unknown>
  if (typeof value.content === "string") return { ...value, content: truncateText(value.content, max) }
  if (!Array.isArray(value.content)) return value
  return {
    ...value,
    content: value.content.map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? { ...part, text: truncateText(String((part as { text?: unknown }).text ?? ""), max) }
        : part,
    ),
  }
}

function compactFallbackMessages(messages: unknown[]) {
  const directive = {
    role: "system",
    content: "Fallback mode: keep answers concise. Use the available tools when needed. The context below is trimmed.",
  }
  const system = messages.filter((message) => (message as { role?: unknown } | null)?.role === "system")
  const rest = messages.filter((message) => (message as { role?: unknown } | null)?.role !== "system")
  const tail = rest.slice(-6).map((message) => compactMessage(message))
  if (!system.length) return [directive, ...tail]
  return [
    directive,
    { role: "system", content: truncateText(textOf((system[0] as { content?: unknown }).content)) },
    ...tail,
  ]
}

function compactFallbackTools(tools: unknown) {
  if (!Array.isArray(tools)) return undefined
  const kept = tools.filter((tool) => {
    const name = (tool as { function?: { name?: unknown } } | null)?.function?.name
    return typeof name === "string" && FALLBACK_TOOLS.has(name)
  })
  return kept.length ? kept : undefined
}

export async function fallbackBody(
  body: Buffer | null,
  model = process.env.OMNICODE_FREE_FALLBACK_MODEL || "openai",
  allowImages = false,
  compact = false,
): Promise<string | null> {
  if (!body) return null
  try {
    const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>
    if (!Array.isArray(parsed.messages)) return null
    const conversation = JSON.stringify(parsed.messages)
    if (
      conversation.includes("You name conversations") ||
      conversation.includes("Summarize what was done in this conversation")
    )
      return null
    const messages = await fallbackMessages(parsed.messages, allowImages)
    const out: Record<string, unknown> = {
      model,
      messages: compact ? compactFallbackMessages(messages) : messages,
      stream: parsed.stream ?? true,
    }
    for (const key of ["tools", "tool_choice", "temperature", "top_p", "stop", "response_format"]) {
      if (parsed[key] !== undefined) out[key] = parsed[key]
    }
    const max = parsed.max_tokens ?? parsed.max_completion_tokens
    if (max !== undefined) out.max_tokens = max
    if (typeof out.max_tokens === "number" && out.max_tokens > 8192) out.max_tokens = 8192
    if (compact) {
      const tools = compactFallbackTools(parsed.tools)
      if (tools) out.tools = tools
      else {
        delete out.tools
        delete out.tool_choice
      }
      const limit = typeof out.max_tokens === "number" ? out.max_tokens : 2048
      out.max_tokens = Math.min(limit, 2048)
    }
    return JSON.stringify(out)
  } catch {
    return null
  }
}

let fallbackTail: Promise<void> = Promise.resolve()

const FREE_LIMIT_DEFAULT_MS = 10 * 60_000
const FREE_LIMIT_MAX_MS = 30 * 60_000
let freeLimitUntil = 0

function noteFreeLimit(headers: Headers) {
  const raw = headers.get("retry-after")
  const seconds = raw === null ? Number.NaN : Number(raw)
  const date = raw === null || Number.isFinite(seconds) ? Number.NaN : Date.parse(raw)
  const wait = Number.isFinite(seconds)
    ? seconds * 1000
    : Number.isFinite(date)
      ? date - Date.now()
      : FREE_LIMIT_DEFAULT_MS
  const clamped = Math.min(FREE_LIMIT_MAX_MS, Math.max(60_000, Number.isFinite(wait) ? wait : FREE_LIMIT_DEFAULT_MS))
  freeLimitUntil = Date.now() + clamped
  diag(`[fallback] free-limit cooldown ${Math.round(clamped / 1000)}s`)
}

function freeLimitCooling() {
  return Date.now() < freeLimitUntil
}

function fallbackEnabled() {
  return OmnicodeSettings.resolved().freeFallback
}

let deepseekKeyCache: string | undefined

async function deepseekKey() {
  if (deepseekKeyCache) return deepseekKeyCache
  const env = process.env.OMNICODE_DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY
  if (env) return (deepseekKeyCache = env)
  const data = process.env.XDG_DATA_HOME || pathJoin(homedir(), ".local", "share")
  for (const name of ["opencode-local.db", "opencode.db"]) {
    try {
      const { Database } = await import("bun:sqlite")
      const db = new Database(pathJoin(data, "opencode", name), { readonly: true })
      try {
        const row = db
          .query("select value from credential where integration_id = 'deepseek' and active = 1 limit 1")
          .get() as { value?: string } | undefined
        if (row?.value === undefined) continue
        const parsed = JSON.parse(row.value) as { type?: string; key?: string }
        if (parsed.type === "key" && parsed.key) return (deepseekKeyCache = parsed.key)
      } finally {
        db.close()
      }
    } catch {
      // Missing DB, old schema, or locked file: try the next path.
    }
  }
  return undefined
}

async function withFallbackSlot(run: (release: () => void) => Promise<Response>): Promise<Response> {
  const previous = fallbackTail
  let resolveSlot!: () => void
  fallbackTail = new Promise<void>((resolve) => (resolveSlot = resolve))
  let released = false
  const release = () => {
    if (released) return
    released = true
    resolveSlot()
  }
  await previous
  try {
    return await run(release)
  } catch (cause) {
    release()
    throw cause
  }
}

function holdFallbackSlot(response: Response, release: () => void): Response {
  if (!response.body) {
    release()
    return response
  }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          release()
          controller.close()
          return
        }
        controller.enqueue(next.value)
      } catch (cause) {
        release()
        controller.error(cause)
      }
    },
    cancel(reason) {
      release()
      return reader.cancel(reason)
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

function busyFallbackBody(text: string) {
  return /previous request is still running|Classic API answers 1 request/i.test(text)
}

export function requestHasImage(body: Buffer | null) {
  if (!body || body.length === 0) return false
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { messages?: unknown }
    if (!Array.isArray(parsed.messages)) return false
    const scan = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false
      if (Array.isArray(value)) return value.some(scan)
      const part = value as Record<string, unknown>
      if (part.type === "image_url" || part.type === "image" || part.type === "input_image") return true
      const file = part.file as { mime_type?: unknown } | undefined
      const mime =
        typeof part.mime_type === "string"
          ? part.mime_type
          : typeof part.mime === "string"
            ? part.mime
            : typeof file?.mime_type === "string"
              ? file.mime_type
              : undefined
      if (typeof mime === "string" && mime.startsWith("image/")) return true
      return "content" in part ? scan(part.content) : false
    }
    return parsed.messages.some(scan)
  } catch {
    return false
  }
}

async function sendNative(
  url: string,
  method: string,
  headerPairs: [string, string][],
  body: Buffer | null,
  timeoutMs = 0,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = new Headers()
  for (const [k, v] of headerPairs) headers.set(k, v)
  const controller = new AbortController()
  if (signal?.aborted) controller.abort()
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  try {
    return await nativeFetch(url, {
      method,
      headers,
      body: body && body.length > 0 ? new Uint8Array(body) : undefined,
      signal: controller.signal,
    })
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

function sendFallback(
  bin: string | null,
  url: string,
  method: string,
  headerPairs: [string, string][],
  body: Buffer | null,
  timeoutMs = 0,
): Promise<Response> {
  if (bin) return impersonateFetchViaSubprocess(bin, url, method, headerPairs, body, false, timeoutMs)
  return sendNative(url, method, headerPairs, body, timeoutMs)
}

async function fallbackResponse(
  bin: string | null,
  url: string,
  body: Buffer | null,
  profile: Profile,
): Promise<Response | undefined> {
  if (!fallbackEnabled() || !/\/chat\/completions(?:\?|$)/.test(url)) return
  const provider = (process.env.OMNICODE_FREE_FALLBACK_PROVIDER || "auto").toLowerCase()
  const key = provider === "pollinations" ? undefined : await deepseekKey()
  if (key !== undefined && provider !== "pollinations") {
    const rewrite = await fallbackBody(body, process.env.OMNICODE_FREE_FALLBACK_DEEPSEEK_MODEL || "deepseek-chat", true)
    if (rewrite) {
      try {
        diag(`[fallback] free limit on ${url.slice(0, 120)} -> deepseek`)
        const response = await sendFallback(
          bin,
          "https://api.deepseek.com/chat/completions",
          "POST",
          [
            ["content-type", "application/json"],
            ["authorization", `Bearer ${key}`],
          ],
          Buffer.from(rewrite, "utf8"),
          90_000,
        )
        diag(`[fallback] deepseek status=${response.status} type=${response.headers.get("content-type") || "n/a"}`)
        if (response.ok) return response
        await response.body?.cancel()
      } catch (e) {
        diag(`[fallback] deepseek failed: ${(e as Error).message}`)
      }
    }
  }
  const rewrite = await fallbackBody(body, process.env.OMNICODE_FREE_FALLBACK_MODEL || "openai", false, true)
  if (!rewrite) return
  const fallbackUrl = process.env.OMNICODE_FREE_FALLBACK_URL || "https://text.pollinations.ai/openai"
  const fbHeaders: [string, string][] = [["content-type", "application/json"]]
  const fbKey = process.env.OMNICODE_FREE_FALLBACK_KEY
  if (fbKey) fbHeaders.push(["authorization", `Bearer ${fbKey}`])
  try {
    diag(`[fallback] free limit on ${url.slice(0, 120)} -> ${fallbackUrl}`)
    return await withFallbackSlot(async (release) => {
      let lastStatus = 0
      let lastHeaders = new Headers()
      let lastText = ""
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await sendFallback(bin, fallbackUrl, "POST", fbHeaders, Buffer.from(rewrite, "utf8"), 90_000)
        diag(
          `[fallback] response status=${response.status} type=${response.headers.get("content-type") || "n/a"} attempt=${attempt + 1}`,
        )
        if (response.status !== 429) return holdFallbackSlot(response, release)
        lastStatus = response.status
        lastHeaders = response.headers
        lastText = await response.text()
        if (!busyFallbackBody(lastText)) {
          release()
          return new Response(lastText, { status: lastStatus, headers: lastHeaders })
        }
        diag(`[fallback] classic slot busy; waiting (attempt=${attempt + 1})`)
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
      }
      release()
      return new Response(lastText, { status: lastStatus, headers: lastHeaders })
    })
  } catch (e) {
    diag(`[fallback] failed: ${(e as Error).message}`)
    return
  }
}

async function fallbackForResponse(
  bin: string | null,
  url: string,
  body: Buffer | null,
  response: Response,
): Promise<Response> {
  if (!fallbackEnabled() || response.status < 400) return response
  if (!/\/chat\/completions(?:\?|$)/.test(url)) return response
  let text = ""
  try {
    text = await response.clone().text()
  } catch {
    return response
  }
  if (!/FreeUsageLimit|free usage limit/i.test(text)) return response
  noteFreeLimit(response.headers)
  diag(`[impersonate] native 429 body profile=${currentProfile()} text=${text.replace(/\r?\n/g, "\\n").slice(0, 300)}`)
  const fallback = await fallbackResponse(bin, url, body, currentProfile())
  if (fallback === undefined) return response
  diag(`[fallback] replaced native 429 for ${url.slice(0, 120)}`)
  try {
    await response.body?.cancel()
  } catch { /* ignore */ }
  return fallback
}

async function impersonateFetchViaSubprocess(
  bin: string,
  url: string,
  method: string,
  headerPairs: [string, string][],
  body: Buffer | null,
  allowFallback = true,
  timeoutMs = 0,
): Promise<Response> {
  const profile = currentProfile()
  const chatUrl = /\/chat\/completions(?:\?|$)/.test(url)
  const vision = chatUrl && requestHasImage(body)
  if (allowFallback && chatUrl && (vision || freeLimitCooling())) {
    const response = await fallbackResponse(bin, url, body, profile)
    if (response !== undefined) {
      diag(
        `[fallback] ${vision ? "vision route" : "cooldown active"}; routed ${url.slice(0, 120)} without probing opencode.ai`,
      )
      return response
    }
  }
  const args: string[] = [
    "--impersonate",
    profile,
    "-s",
    "-i",
    "--suppress-connect-headers",
    "--compressed",
    "--no-buffer",
    "-X",
    method,
  ]
  if (timeoutMs > 0) args.push("--max-time", String(Math.ceil(timeoutMs / 1000)))

  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  const local = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/i.test(url)
  if (proxy && !local) args.push("-x", proxy)

  const dropped = new Set(["accept-encoding", "content-length", "host"])
  const isInferenceReq = /\/inference\//.test(url)
  const sentHeaders: string[] = []
  for (const [k, v] of headerPairs) {
    if (dropped.has(k.toLowerCase())) continue
    args.push("-H", `${k}: ${v}`)
    if (k.toLowerCase() === "authorization") {
      sentHeaders.push(`${k}: ${v.replace(/Bearer\s+\S+/i, "Bearer <" + (v.slice(7, 12) || "?") + "...>")}`)
    } else if (k.toLowerCase() === "cookie" || k.toLowerCase() === "set-cookie") {
      sentHeaders.push(`${k}: <${v.length}B: ${v.slice(0, 80)}...>`)
    } else {
      sentHeaders.push(`${k}: ${v.slice(0, 200)}`)
    }
  }
  if (isInferenceReq) {
    diag(
      `[impersonate] req-headers profile=${profile} ${method} ${url.slice(0, 120)}: ${sentHeaders.join(" | ").slice(0, 2000)}`,
    )
  }

  if (body && body.length > 0) {
    args.push("--data-binary", "@-")
  }
  args.push(url)

  return new Promise<Response>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    const stderrChunks: Buffer[] = []
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk as Buffer))
    child.on("error", (e) => {
      diag(`[impersonate] spawn error: ${e.message}`)
      reject(e)
    })

    const headBuf: Buffer[] = []
    let headSeen = false
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null
    let settled = false
    let totalBodyBytes = 0
    const SAMPLE_CAP = 4096
    const sampleHead: Buffer[] = []
    const sampleTail: Buffer[] = []
    let sampleHeadLen = 0
    let responseStatus = 0
    let responseContentType = ""
    let errorBuffering = false
    let errorStatus = 0
    let errorHeaders: Headers | null = null
    let errorBytes = 0
    const errorChunks: Buffer[] = []
    const settleBufferedError = async (): Promise<Response> => {
      const text = Buffer.concat(errorChunks).toString("utf8")
      const headers = errorHeaders ?? new Headers({ "content-type": "application/json" })
      const isFreeLimit = /FreeUsageLimit|free usage limit/i.test(text)
      if (isFreeLimit) {
        noteFreeLimit(headers)
        diag(
          `[impersonate] 429 body profile=${profile} bytes=${errorBytes} text=${text.replace(/\r?\n/g, "\\n").slice(0, 300)}`,
        )
      }
      if (allowFallback && fallbackEnabled() && isFreeLimit && /\/chat\/completions(?:\?|$)/.test(url)) {
        const response = await fallbackResponse(bin, url, body, profile)
        if (response !== undefined) return response
      }
      return new Response(text, { status: errorStatus, headers })
    }

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      if (err) {
        diag(`[impersonate] stream error profile=${profile} url=${url.slice(0, 120)}: ${err.message}`)
        if (bodyController) {
          try { bodyController.error(err) } catch { /* ignore */ }
        } else {
          reject(err)
        }
        return
      }
      if (bodyController) {
        try { bodyController.close() } catch { /* ignore */ }
      }
    }

    const bodyStream = new ReadableStream<Uint8Array>({
      start(ctrl) { bodyController = ctrl },
      cancel(reason) {
        diag(`[impersonate] body stream cancelled: ${String(reason)}`)
        try { child.kill() } catch { /* ignore */ }
      },
    })

    const emitBody = (chunk: Buffer) => {
      if (chunk.length === 0) return
      totalBodyBytes += chunk.length
      if (errorBuffering) {
        if (errorBytes < 64 * 1024) {
          errorChunks.push(chunk)
          errorBytes += chunk.length
        }
        return
      }
      if (sampleHeadLen < SAMPLE_CAP) {
        const room = SAMPLE_CAP - sampleHeadLen
        const take = chunk.length <= room ? chunk : chunk.subarray(0, room)
        sampleHead.push(take)
        sampleHeadLen += take.length
        if (chunk.length > room) sampleTail.push(chunk.subarray(room))
      } else {
        sampleTail.push(chunk)
      }
      let tailBytes = 0
      for (const b of sampleTail) tailBytes += b.length
      while (tailBytes > SAMPLE_CAP && sampleTail.length > 1) {
        tailBytes -= sampleTail[0].length
        sampleTail.shift()
      }
      if (bodyController) {
        try { bodyController.enqueue(new Uint8Array(chunk)) } catch { /* ignore */ }
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (headSeen) {
        emitBody(chunk)
        return
      }
      headBuf.push(chunk)
      const combined = Buffer.concat(headBuf)
      const parsed = parseResponseHead(combined, Boolean(proxy))
      if (!parsed) {
        if (combined.length > 1024 * 1024) {
          finish(new Error("curl-impersonate: response head exceeded 1 MiB without terminator"))
          try { child.kill() } catch { /* ignore */ }
        }
        return
      }
      headSeen = true
      responseStatus = parsed.status
      const headers = new Headers()
      for (const [k, v] of parsed.headers) {
        try { headers.append(k, v) } catch { /* ignore */ }
        if (k.toLowerCase() === "content-type") responseContentType = v
      }
      diag(
        `[impersonate] profile=${profile} ${method} ${url.slice(0, 120)} -> ${parsed.status} ` +
          `(streaming, proxy=${proxy || "none"}, ct=${responseContentType || "n/a"})`,
      )
      if (parsed.status === 429) {
        errorBuffering = true
        errorStatus = parsed.status
        errorHeaders = headers
      } else {
        resolve(
          new Response(bodyStream, {
            status: parsed.status,
            statusText: parsed.statusText,
            headers,
          }),
        )
      }
      const tail = combined.subarray(parsed.bodyOffset)
      if (tail.length > 0) emitBody(tail)
    })

    child.on("close", (code) => {
      const errText = Buffer.concat(stderrChunks).toString("utf8").slice(0, 2048)
      if (!headSeen) {
        const combined = Buffer.concat(headBuf)
        const msg =
          code === 0
            ? `curl-impersonate produced no parseable HTTP head (stdoutLen=${combined.length}, stderr=${errText.slice(0, 200)})`
            : `curl-impersonate exit ${code}: ${errText}`
        diag(`[impersonate] early-exit profile=${profile} url=${url.slice(0, 120)} code=${code} ${msg.slice(0, 300)}`)
        reject(new Error(msg))
        return
      }
      if (errorBuffering) {
        if (code !== 0) {
          diag(`[impersonate] 429 stream exit ${code} profile=${profile} url=${url.slice(0, 120)} bytes=${errorBytes}`)
        }
        void settleBufferedError()
          .then(resolve)
          .catch((e) => {
            diag(`[fallback] settle failed: ${(e as Error).message}`)
            resolve(new Response("free-limit fallback failed", { status: 502 }))
          })
        return
      }
      if (code !== 0) {
        diag(
          `[impersonate] stream aborted profile=${profile} url=${url.slice(0, 120)} code=${code} bytes=${totalBodyBytes} stderr=${errText.slice(0, 200)}`,
        )
        finish(new Error(`curl-impersonate exit ${code}: ${errText}`))
        return
      }
      diag(`[impersonate] stream done profile=${profile} url=${url.slice(0, 120)} status=${responseStatus} bytes=${totalBodyBytes}`)
      const isInference = /\/inference\/|\/chat\/completions/.test(url)
      const shouldSample = totalBodyBytes <= 16 * 1024 || isInference
      if (shouldSample) {
        const headText = Buffer.concat(sampleHead, Math.min(sampleHeadLen, SAMPLE_CAP))
          .toString("utf8")
          .replace(/\r?\n/g, "\\n")
          .slice(0, 2000)
        const tailBuf = Buffer.concat(sampleTail)
        const tailText = tailBuf.length > 0 ? tailBuf.toString("utf8").replace(/\r?\n/g, "\\n").slice(-1000) : ""
        diag(
          `[impersonate] body-sample profile=${profile} status=${responseStatus} bytes=${totalBodyBytes} HEAD="${headText}"${tailText && tailText !== headText ? ` TAIL="${tailText}"` : ""}`,
        )
      }
      finish()
    })

    if (body && body.length > 0) {
      child.stdin.write(body)
    }
    child.stdin.end()
  })
}

export function installImpersonateFetchOverride(): { installed: boolean; reason?: string } {
  const bin = resolveImpersonateBin()
  if ((globalThis as { __omnicodeImpersonateInstalled?: boolean }).__omnicodeImpersonateInstalled) {
    return { installed: true, reason: "already installed" }
  }
  if (typeof globalThis.fetch !== "function") {
    return { installed: false, reason: "no native fetch to override" }
  }
  nativeFetch = globalThis.fetch.bind(globalThis)
  ;(globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
      const host = new URL(url).hostname.toLowerCase()
      if (!isOpencodeHost(host)) {
        return nativeFetch(input as RequestInfo | URL, init)
      }
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
      const headerPairs = toHeaderPairs(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      const bodySource =
        init?.body ??
        (input instanceof Request && method !== "GET" && method !== "HEAD" ? await input.clone().arrayBuffer() : null)
      const bodyBuf = await bodyToBuffer(bodySource as BodyInit | null)
      if (bin) return await impersonateFetchViaSubprocess(bin, url, method, headerPairs, bodyBuf)
      const chatUrl = /\/chat\/completions(?:\?|$)/.test(url)
      const vision = chatUrl && requestHasImage(bodyBuf)
      if (chatUrl && fallbackEnabled() && (vision || freeLimitCooling())) {
        const fallback = await fallbackResponse(null, url, bodyBuf, currentProfile())
        if (fallback !== undefined) {
          diag(
            `[fallback] ${vision ? "vision route" : "cooldown active"}; routed ${url.slice(0, 120)} without probing opencode.ai`,
          )
          return fallback
        }
      }
      const response = await sendNative(
        url,
        method,
        headerPairs,
        bodyBuf,
        0,
        init?.signal ?? (input instanceof Request ? input.signal : undefined),
      )
      return await fallbackForResponse(null, url, bodyBuf, response)
    } catch (e) {
      diag(`[impersonate] fetch override ERROR, falling through to native: ${(e as Error).message}`)
      return nativeFetch(input as RequestInfo | URL, init)
    }
  }) as typeof globalThis.fetch
  ;(globalThis as { __omnicodeImpersonateInstalled?: boolean }).__omnicodeImpersonateInstalled = true
  diag(
    `[impersonate] global fetch override INSTALLED (opencode.ai hosts routed via ${bin ? "curl-impersonate" : "native fetch + free fallback"})`,
  )
  return { installed: true }
}
