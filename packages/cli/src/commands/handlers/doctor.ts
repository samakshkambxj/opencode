import { Global } from "@opencode/util/global"
import { inspect } from "@opencode/util/omnicode-dependencies"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Effect } from "effect"
import { EOL, homedir } from "node:os"
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { databasePath } from "../../database-path"
import { ServerConnection } from "../../services/server-connection"
import { errorMessage } from "../../util/error"
import { OPENCODE_VERSION } from "../../version"
import { request } from "./stats"

type Status = "ok" | "warn" | "fail" | "info"

type Check = {
  name: string
  status: Status
  detail: string
  hint?: string
  critical?: boolean
}

const handler = Effect.fn("cli.doctor")(function* (input: Runtime.Input<typeof Commands.commands.doctor>) {
  const global = yield* Global.Service
  const checks: Check[] = []

  const server = yield* Effect.result(
    Effect.gen(function* () {
      const connection = yield* ServerConnection.resolve()
      const client = OpenCode.make({
        baseUrl: connection.endpoint.url,
        headers: Service.headers(connection.endpoint),
      })
      const info = yield* request(connection.endpoint.url, (signal) => client.server.info({ signal }))
      return {
        url: connection.endpoint.url,
        version: info.version,
        standalone: connection.standalone === true,
      }
    }),
  )
  if (server._tag === "Failure") {
    checks.push({
      name: "Server",
      status: "fail",
      detail: errorMessage(server.failure),
      hint: "Start Omnicode, or run `omnicode serve` and retry.",
      critical: true,
    })
  } else {
    const mismatch = server.success.version !== OPENCODE_VERSION
    checks.push({
      name: "Server",
      status: mismatch ? "warn" : "ok",
      detail: `${server.success.url} · v${server.success.version}${server.success.standalone ? " · standalone" : ""}`,
      hint: mismatch ? `This CLI is ${OPENCODE_VERSION}; restart the background service to match.` : undefined,
    })
  }

  const writable = writableDirectory(global.data)
  checks.push({
    name: "Data directory",
    status: !existsSync(global.data) ? "warn" : writable ? "ok" : "fail",
    detail: existsSync(global.data)
      ? writable
        ? global.data
        : `${global.data} (not writable)`
      : `${global.data} (missing; created on first run)`,
    hint: writable ? undefined : "Check folder permissions or point XDG_DATA_HOME at a writable directory.",
    critical: true,
  })

  const database = databasePath(global.data)
  const memory = database === ":memory:"
  const databaseExists = memory || existsSync(database)
  checks.push({
    name: "Database",
    status: memory ? "info" : databaseExists ? "ok" : "warn",
    detail: memory
      ? "in-memory database"
      : databaseExists
        ? `${database} (${formatBytes(fileSize(database))})`
        : `${database} (not created yet)`,
    hint: databaseExists ? undefined : "The database is created when the server first starts.",
  })

  const dependencies = inspect()
  for (const dependency of dependencies.dependencies) {
    checks.push({
      name: dependency.name,
      status: dependency.installed ? "ok" : "warn",
      detail: dependency.detail,
      hint: dependency.installed ? undefined : dependency.hint,
    })
  }

  checks.push({
    name: "Proxy",
    status: dependencies.proxy.configured ? "ok" : "info",
    detail: dependencies.proxy.value ?? "No HTTPS_PROXY set; egress uses the system network.",
    hint: dependencies.proxy.configured
      ? undefined
      : "Cloudflare WARP routes traffic at the system level, so a proxy is optional.",
  })

  const databases = findOpenCodeDatabases(global.data)
  checks.push({
    name: "OpenCode data",
    status: databases.length > 0 ? "ok" : "info",
    detail:
      databases.length > 0
        ? `${databases.length} database${databases.length === 1 ? "" : "s"}: ${databases.join(", ")}`
        : "No OpenCode sessions found to import.",
    hint:
      databases.length > 0
        ? undefined
        : "Set OMNICODE_OPENCODE_DB to an OpenCode database to make it visible in /sessions.",
  })

  checks.push({
    name: "CLI",
    status: "ok",
    detail: `${process.execPath} · v${OPENCODE_VERSION}`,
  })

  const output = input.json
    ? JSON.stringify(
        {
          ok: !checks.some((check) => check.status === "fail" && check.critical),
          checks,
          warnings: checks.filter((check) => check.status === "warn" || check.status === "fail"),
        },
        null,
        2,
      )
    : render(checks)
  process.stdout.write(output + EOL)
  if (checks.some((check) => check.status === "fail" && check.critical)) process.exitCode = 1
})

export default Runtime.handler(Commands.commands.doctor, (input) =>
  handler(input).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        process.stderr.write(errorMessage(error) + EOL)
        process.exitCode = 1
      }),
    ),
  ),
)

function render(checks: ReadonlyArray<Check>) {
  const lines = ["OMNICODE DOCTOR", "", ...checks.map(renderCheck)]
  const warnings = checks.filter((check) => check.status === "warn" || check.status === "fail")
  if (warnings.length > 0) {
    lines.push("", "WARNINGS")
    for (const check of warnings) {
      lines.push(`  - ${check.name}: ${check.detail}`)
      if (check.hint) lines.push(`    ${check.hint}`)
    }
  }
  return lines.join(EOL)
}

function renderCheck(check: Check) {
  const label = `[${check.status}]`.padEnd(7)
  return `  ${label}${check.name.padEnd(20)}${check.detail}${check.hint ? `${EOL}         ${check.hint}` : ""}`
}

function writableDirectory(directory: string) {
  try {
    accessSync(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function fileSize(file: string) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function findOpenCodeDatabases(exclude: string) {
  const home = homedir()
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming")
  const roots = [exclude, process.env.OMNICODE_DESKTOP_XDG_ROOT].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
  const found: string[] = []
  const databaseName = /^opencode(?:-[a-zA-Z0-9._-]+)?\.db$/i
  const addFile = (file: string) => {
    if (!existsSync(file) || !statSync(file).isFile()) return
    const resolved = path.resolve(file)
    if (roots.some((root) => isInside(resolved, root))) return
    if (!found.includes(resolved)) found.push(resolved)
  }
  const addDirectory = (directory: string | undefined) => {
    if (!directory || !existsSync(directory)) return
    try {
      for (const name of readdirSync(directory)) if (databaseName.test(name)) addFile(path.join(directory, name))
    } catch {
      // An unreadable OpenCode profile is not a Omnicode failure.
    }
  }

  if (process.env.OMNICODE_OPENCODE_DB) addFile(process.env.OMNICODE_OPENCODE_DB)
  addDirectory(process.env.OMNICODE_OPENCODE_DATA)
  addDirectory(path.join(home, ".local", "share", "opencode"))
  if (process.platform === "win32") addDirectory(path.join(appData, "ai.opencode.desktop", "xdg", "data", "opencode"))
  if (process.platform === "darwin")
    addDirectory(path.join(home, "Library", "Application Support", "ai.opencode.desktop", "xdg", "data", "opencode"))
  if (process.platform === "linux")
    addDirectory(
      path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
        "ai.opencode.desktop",
        "xdg",
        "data",
        "opencode",
      ),
    )
  if (process.env.XDG_DATA_HOME) addDirectory(path.join(process.env.XDG_DATA_HOME, "opencode"))
  return found
}

function isInside(file: string, root: string) {
  const relative = path.relative(path.resolve(root), file)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
