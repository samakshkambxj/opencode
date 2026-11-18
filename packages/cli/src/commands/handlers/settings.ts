import { Global } from "@opencode/util/global"
import { inspect } from "@opencode/util/omnicode-dependencies"
import * as OmnicodeSettings from "@opencode/util/omnicode-settings"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Effect, Option } from "effect"
import { readFileSync } from "node:fs"
import { EOL } from "node:os"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Config } from "../../config"
import { databasePath } from "../../database-path"
import { ServerConnection } from "../../services/server-connection"
import { errorMessage } from "../../util/error"
import { redactConfig } from "./debug/redact"
import { request } from "./stats"

const handler = Effect.fn("cli.settings")(function* (input: Runtime.Input<typeof Commands.commands.settings>) {
  const server = yield* ServerConnection.resolve()
  const client = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
  const config = yield* Config.Service
  const global = yield* Global.Service
  const entries = yield* request(server.endpoint.url, (signal) =>
    client.config.get({ location: { directory: process.cwd() } }, { signal }),
  )
  const resolved: Record<string, unknown> = {}
  for (const entry of entries) {
    if (entry.type !== "document") continue
    Object.assign(resolved, entry.info)
  }
  const report = {
    cli: yield* config.get(),
    server: redactConfig(resolved) as Record<string, unknown>,
    paths: { ...global, db: databasePath(global.data) },
    omnicode: {
      settings: OmnicodeSettings.resolved(),
      sources: OmnicodeSettings.sources(),
      autoJb: autoJb(global.data),
      dependencies: inspect(),
      settingsPath: OmnicodeSettings.filePath(),
    },
    environment: environment(),
  }
  const key = Option.getOrUndefined(input.key)
  if (key !== undefined) {
    const value = pick(report, key)
    if (value === undefined) yield* Effect.fail(new Error(`Unknown setting: ${key}`))
    process.stdout.write((typeof value === "string" ? value : JSON.stringify(value, null, 2)) + EOL)
    return
  }
  const output = input.json ? JSON.stringify(report, null, 2) : render(report, config.path)
  process.stdout.write(output + EOL)
})

export default Runtime.handler(Commands.commands.settings, (input) =>
  handler(input).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        process.stderr.write(errorMessage(error) + EOL)
        process.exitCode = 1
      }),
    ),
  ),
)

type AutoJb = {
  enabled: boolean
  content: "default" | "custom" | "empty"
  length?: number
  path: string
}

type Report = {
  cli: unknown
  server: Record<string, unknown>
  paths: Record<string, string>
  omnicode: {
    settings: OmnicodeSettings.Resolved
    sources: Record<OmnicodeSettings.Key, OmnicodeSettings.Source>
    autoJb: AutoJb
    dependencies: ReturnType<typeof inspect>
    settingsPath: string
  }
  environment: Record<string, string>
}

function render(report: Report, cliPath: string) {
  const lines = ["OMNICODE SETTINGS", "", `CLI SETTINGS · ${cliPath}`]
  const cli = flatten(report.cli)
  lines.push(...(cli.length === 0 ? ["  (empty)"] : cli.map(([key, value]) => row(key, value))))
  lines.push("", "SERVER CONFIG")
  const server = Object.entries(report.server)
  lines.push(...(server.length === 0 ? ["  (empty)"] : server.map(([key, value]) => row(key, printable(value)))))
  lines.push("", "PATHS", ...Object.entries(report.paths).map(([key, value]) => row(key, value)))

  const omnicode = report.omnicode
  lines.push(
    "",
    "OMNICODE",
    row("autoRotate", `${onOff(omnicode.settings.autoRotate)} (${omnicode.sources.autoRotate})`),
    row("autoRotateMaxPerHour", String(omnicode.settings.autoRotateMaxPerHour)),
    row("freeFallback", `${onOff(omnicode.settings.freeFallback)} (${omnicode.sources.freeFallback})`),
    row("forceTor", `${onOff(omnicode.settings.forceTor)} (${omnicode.sources.forceTor})`),
    row(
      "autoJb",
      `${onOff(omnicode.autoJb.enabled)} · ${omnicode.autoJb.content}${
        omnicode.autoJb.length === undefined ? "" : ` (${omnicode.autoJb.length} chars)`
      }`,
    ),
    row("settings", omnicode.settingsPath),
  )

  lines.push("", "DEPENDENCIES")
  for (const dependency of omnicode.dependencies.dependencies) {
    lines.push(
      row(dependency.name, dependency.installed ? `installed · ${dependency.path}` : `MISSING · ${dependency.detail}`),
    )
  }
  lines.push(row("proxy", omnicode.dependencies.proxy.value ?? "(not set)"))

  lines.push("", "ENVIRONMENT", ...Object.entries(report.environment).map(([key, value]) => row(key, value)))
  return lines.join(EOL)
}

function flatten(value: unknown, prefix = ""): Array<[string, string]> {
  if (value === undefined) return []
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return [[prefix || "(root)", printable(value)]]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix === "" ? key : `${prefix}.${key}`),
  )
}

function pick(value: unknown, key: string): unknown {
  let current = value
  for (const part of key.split(".").filter(Boolean)) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function row(key: string, value: string) {
  return `  ${key.padEnd(34)} ${value}`
}

function printable(value: unknown) {
  if (typeof value === "string") return value
  return JSON.stringify(value) ?? String(value)
}

function environment(): Record<string, string> {
  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy
  return {
    OMNICODE_AUTO_ROTATE: toggle("OMNICODE_AUTO_ROTATE", true),
    OMNICODE_AUTO_ROTATE_MAX_PER_HOUR: process.env.OMNICODE_AUTO_ROTATE_MAX_PER_HOUR ?? "30 (default)",
    OMNICODE_FREE_FALLBACK: toggle("OMNICODE_FREE_FALLBACK", true),
    OMNICODE_FORCE_TOR: toggle("OMNICODE_FORCE_TOR", false),
    OMNICODE_SPOOF_UNLIMITED: toggle("OMNICODE_SPOOF_UNLIMITED", false),
    OMNICODE_REQUIRE_PROXY: toggle("OMNICODE_REQUIRE_PROXY", false),
    OMNICODE_SPOOF_SESSION: toggle("OMNICODE_SPOOF_SESSION", true),
    OMNICODE_SPOOF_UA: toggle("OMNICODE_SPOOF_UA", true),
    OMNICODE_SPOOF_CLIENT: toggle("OMNICODE_SPOOF_CLIENT", true),
    HTTPS_PROXY: proxy ? redactProxy(proxy) : "(not set)",
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR ?? "(default)",
    OPENCODE_PASSWORD: process.env.OPENCODE_PASSWORD ? "***" : "(not set)",
  }
}

function toggle(name: string, enabledByDefault: boolean) {
  const raw = process.env[name]?.trim().toLowerCase()
  if (raw === undefined || raw === "") return enabledByDefault ? "on (default)" : "off (default)"
  return raw === "0" || raw === "false" ? "off" : "on"
}

function onOff(value: boolean) {
  return value ? "on" : "off"
}

function autoJb(data: string): AutoJb {
  const file = path.join(data, "omnicode-abliterated.json")
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    if (!state || typeof state !== "object") return { enabled: false, content: "default", path: file }
    const content = typeof state.content === "string" ? state.content : undefined
    return {
      enabled: state.enabled === true,
      content: content === undefined ? "default" : content.length === 0 ? "empty" : "custom",
      length: content?.length,
      path: file,
    }
  } catch {
    return { enabled: false, content: "default", path: file }
  }
}

function redactProxy(value: string) {
  try {
    const url = new URL(value)
    if (url.username || url.password) {
      url.username = "***"
      url.password = "***"
    }
    return url.toString()
  } catch {
    return value
  }
}
