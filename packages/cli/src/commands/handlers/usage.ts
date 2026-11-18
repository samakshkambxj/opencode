import {
  OpenCode,
  type SessionStatsInfo,
  type UsageLimitsBudget,
  type UsageLimitsInfo,
  type UsageLimitsMeter,
} from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { TokenUsage } from "@opencode/schema/token-usage"
import { Effect } from "effect"
import { EOL } from "node:os"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { errorMessage } from "../../util/error"
import { request } from "./stats"

const handler = Effect.fn("cli.usage")(function* (input: Runtime.Input<typeof Commands.commands.usage>) {
  const server = yield* ServerConnection.resolve()
  const client = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
  const days = input.days
  const usage = yield* request(server.endpoint.url, (signal) =>
    client.experimental.usage.limits({ location: { directory: process.cwd() } }, { signal }),
  )
  const limits = usage.data
  const hasLimits = limits !== null && (limits.go !== undefined || limits.budgets.length > 0)
  const stats = hasLimits
    ? undefined
    : yield* request(server.endpoint.url, (signal) => {
        const to = Date.now()
        return client.experimental.session.stats(
          {
            from: to - days * 86_400_000,
            to: to + 1,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            tools: "none",
          },
          { signal },
        )
      })
  const output = input.json
    ? JSON.stringify({ limits, stats: stats ?? null }, null, 2)
    : renderUsage(limits, stats, {
        days,
        color: process.stdout.isTTY && process.env.NO_COLOR === undefined,
      })
  process.stdout.write(output + EOL)
})

export default Runtime.handler(Commands.commands.usage, (input) =>
  handler(input).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        process.stderr.write(errorMessage(error) + EOL)
        process.exitCode = 1
      }),
    ),
  ),
)

const barWidth = 24
const primary = "36"

function renderUsage(
  limits: UsageLimitsInfo | null,
  stats: SessionStatsInfo | undefined,
  options: { days: number; color: boolean },
) {
  const title = limits?.workspace.name ?? limits?.workspace.id ?? "no limits"
  const lines = [`${style("omnicode usage", `1;${primary}`, options.color)} ${style(`· ${title}`, "2", options.color)}`]

  if (limits?.go) {
    lines.push(
      "",
      style("GO ALLOWANCE", "1", options.color),
      renderMeter("rolling", limits.go.rolling, options.color),
      renderMeter("weekly", limits.go.weekly, options.color),
      renderMeter("monthly", limits.go.monthly, options.color),
    )
  }

  if (limits && limits.budgets.length > 0) {
    lines.push("", style("BUDGETS", "1", options.color))
    for (const budget of limits.budgets) lines.push(renderBudget(budget, options.color))
  }

  if (!limits?.go && (limits?.budgets.length ?? 0) === 0) {
    lines.push(
      "",
      `  ${style("no Go allowance or budgets on this workspace", "2", options.color)}`,
      `  ${style("the free route rotates automatically; models are not gated by a quota", "2", options.color)}`,
    )
  }

  if (stats)
    lines.push(
      "",
      `${style(`LOCAL ACTIVITY · last ${options.days} day${options.days === 1 ? "" : "s"}`, "1", options.color)}`,
      `  ${metric(stats.sessions, "session", options.color)} · ${metric(stats.prompts, "prompt", options.color)} · ${metric(TokenUsage.total(stats.tokens), "token", options.color)} · ${metric(stats.activeDays, "active day", options.color)} · best streak ${style(stats.streak.toString(), `1;${primary}`, options.color)} day${stats.streak === 1 ? "" : "s"}`,
      `  ${style(sparkline(stats, options.days), primary, options.color)}`,
      "",
      `  ${style("github.com/Tazmyan/Omnicode", "2", options.color)}`,
    )

  return lines.join(EOL)
}

function renderMeter(label: string, meter: UsageLimitsMeter, color: boolean) {
  return `  ${label.padEnd(8)}${bar(meter.percent, meter.limited, color)} ${formatPercent(meter.percent).padStart(6)}  ${resetText(meter.resetsAt)}`
}

function renderBudget(budget: UsageLimitsBudget, color: boolean) {
  const percent = budget.limit === 0 ? 100 : Math.min(100, (budget.spent / budget.limit) * 100)
  const notes = [
    budget.scope === "combined" ? "pooled" : undefined,
    budget.per === "model" ? "per model" : undefined,
    budget.coverage === "all" ? "all services" : undefined,
  ]
    .filter((note): note is string => note !== undefined)
    .join(", ")
  const amount = `$${budget.spent.toFixed(2)} / $${budget.limit.toFixed(2)}`
  return `  ${budget.id.padEnd(8)}${bar(percent, percent >= 100, color)} ${formatPercent(percent).padStart(6)}  ${amount}  ${resetText(budget.resetsAt)}${notes ? ` · ${notes}` : ""}`
}

function bar(percent: number, limited: boolean, color: boolean) {
  const filled = Math.max(0, Math.min(barWidth, Math.round((Math.max(0, Math.min(100, percent)) / 100) * barWidth)))
  const fill = style("█".repeat(filled), limited ? "31" : primary, color)
  const empty = style("░".repeat(barWidth - filled), "2", color)
  return `${fill}${empty}`
}

function resetText(at: number) {
  if (!Number.isFinite(at)) return ""
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ""
  const absolute = date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
  return `${countdown(at)} (${absolute})`
}

function countdown(at: number) {
  const remaining = at - Date.now()
  if (remaining <= 0) return "resets now"
  const minutes = Math.ceil(remaining / 60_000)
  if (minutes < 60) return `resets in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 48) return `resets in ${hours}h${rest === 0 ? "" : ` ${rest}m`}`
  const days = Math.floor(hours / 24)
  const leftover = hours % 24
  return `resets in ${days}d${leftover === 0 ? "" : ` ${leftover}h`}`
}

function sparkline(stats: SessionStatsInfo, days: number) {
  const steps = new Map(stats.activity.map((day) => [day.date, day.steps]))
  const formatter = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" })
  const values = Array.from({ length: days }, (_, index) => {
    const date = new Date()
    date.setDate(date.getDate() - (days - 1 - index))
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]))
    return steps.get(`${parts.year}-${parts.month}-${parts.day}`) ?? 0
  })
  const max = Math.max(...values, 1)
  const levels = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
  return values
    .map((value) =>
      value === 0 ? "·" : levels[Math.min(levels.length - 1, Math.floor((value / max) * levels.length))],
    )
    .join("")
}

function metric(value: number, noun: string, color: boolean) {
  return `${style(formatNumber(value), `1;${primary}`, color)} ${noun}${value === 1 ? "" : "s"}`
}

function formatPercent(value: number) {
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`
}

function formatNumber(value: number) {
  if (value >= 1_000_000_000) return `${trimDecimal(value / 1_000_000_000)}b`
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}m`
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}k`
  return Math.round(value).toLocaleString("en-US")
}

function trimDecimal(value: number) {
  return value.toFixed(1).replace(/\.0$/, "")
}

function style(value: string, code: string, color: boolean) {
  return color ? `\x1b[${code}m${value}\x1b[0m` : value
}
