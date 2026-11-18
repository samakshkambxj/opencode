import fs from "node:fs"
import path from "node:path"
import { roots } from "#global-roots"

const FILE = path.join(roots("opencode").data, "omnicode-settings.json")

export type Key = "autoRotate" | "freeFallback" | "forceTor"
export type Source = "env" | "file" | "default"

export type Stored = {
  autoRotate?: boolean
  autoRotateMaxPerHour?: number
  freeFallback?: boolean
  forceTor?: boolean
}

export type Resolved = {
  autoRotate: boolean
  autoRotateMaxPerHour: number
  freeFallback: boolean
  forceTor: boolean
}

export type Patch = Partial<Resolved>

export const Defaults: Resolved = {
  autoRotate: true,
  autoRotateMaxPerHour: 30,
  freeFallback: true,
  forceTor: false,
}

export function filePath() {
  return FILE
}

function read(): Stored {
  try {
    const value = JSON.parse(fs.readFileSync(FILE, "utf8")) as unknown
    return value && typeof value === "object" ? (value as Stored) : {}
  } catch {
    return {}
  }
}

function write(state: Stored) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  const temp = `${FILE}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8")
  fs.renameSync(temp, FILE)
}

function envBool(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) return undefined
  if (["1", "true", "yes", "on"].includes(value)) return true
  if (["0", "false", "no", "off"].includes(value)) return false
  return undefined
}

function envNumber(name: string): number | undefined {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined
}

function storedBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function storedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined
}

export function resolved(): Resolved {
  const state = read()
  return {
    autoRotate: envBool("OMNICODE_AUTO_ROTATE") ?? storedBool(state.autoRotate) ?? Defaults.autoRotate,
    autoRotateMaxPerHour:
      envNumber("OMNICODE_AUTO_ROTATE_MAX_PER_HOUR") ??
      storedNumber(state.autoRotateMaxPerHour) ??
      Defaults.autoRotateMaxPerHour,
    freeFallback: envBool("OMNICODE_FREE_FALLBACK") ?? storedBool(state.freeFallback) ?? Defaults.freeFallback,
    forceTor: envBool("OMNICODE_FORCE_TOR") ?? storedBool(state.forceTor) ?? Defaults.forceTor,
  }
}

export function sources(): Record<Key, Source> {
  const state = read()
  const source = (env: string, value: unknown): Source =>
    envBool(env) !== undefined ? "env" : storedBool(value) !== undefined ? "file" : "default"
  return {
    autoRotate: source("OMNICODE_AUTO_ROTATE", state.autoRotate),
    freeFallback: source("OMNICODE_FREE_FALLBACK", state.freeFallback),
    forceTor: source("OMNICODE_FORCE_TOR", state.forceTor),
  }
}

export function set(patch: Patch): Resolved {
  const current = read()
  const next: Stored = { ...current }
  if (patch.autoRotate !== undefined) next.autoRotate = Boolean(patch.autoRotate)
  if (patch.freeFallback !== undefined) next.freeFallback = Boolean(patch.freeFallback)
  if (patch.forceTor !== undefined) next.forceTor = Boolean(patch.forceTor)
  if (patch.autoRotateMaxPerHour !== undefined) {
    const value = Number(patch.autoRotateMaxPerHour)
    if (!Number.isFinite(value) || value < 1) throw new Error("autoRotateMaxPerHour must be at least 1")
    next.autoRotateMaxPerHour = Math.floor(value)
  }
  write(next)
  return resolved()
}
