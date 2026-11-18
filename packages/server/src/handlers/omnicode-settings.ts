import { OmnicodeAbliterated } from "@opencode/core/omnicode-abliterated"
import { inspect } from "@opencode/util/omnicode-dependencies"
import * as OmnicodeSettings from "@opencode/util/omnicode-settings"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { omnicodePreflight } from "./omnicode-reset"

function payload() {
  const report = inspect()
  return {
    ok: true,
    settings: OmnicodeSettings.resolved(),
    sources: OmnicodeSettings.sources(),
    settingsPath: OmnicodeSettings.filePath(),
    autoJb: {
      enabled: OmnicodeAbliterated.enabled(),
      custom: OmnicodeAbliterated.custom(),
      length: OmnicodeAbliterated.content().length,
      defaultLength: OmnicodeAbliterated.DefaultContent.length,
      max: OmnicodeAbliterated.MaxContentLength,
    },
    dependencies: report.dependencies,
    proxy: report.proxy,
    missing: report.missing,
  }
}

export const OmnicodeSettingsLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("OPTIONS", "/_omnicode/settings", omnicodePreflight)
    yield* router.add(
      "GET",
      "/_omnicode/settings",
      Effect.sync(() => HttpServerResponse.jsonUnsafe(payload())),
    )
    yield* router.add(
      "POST",
      "/_omnicode/settings",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const parsed = yield* Effect.result(request.json)
        if (parsed._tag === "Failure")
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "invalid JSON body" }, { status: 400 })

        const body = parsed.success
        if (body === null || typeof body !== "object" || Array.isArray(body))
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "JSON object required" }, { status: 400 })

        const input = body as Record<string, unknown>
        const patch: OmnicodeSettings.Patch = {}
        for (const key of ["autoRotate", "freeFallback", "forceTor"] as const) {
          if (!(key in input)) continue
          if (typeof input[key] !== "boolean")
            return HttpServerResponse.jsonUnsafe({ ok: false, error: `${key} must be a boolean` }, { status: 400 })
          patch[key] = input[key]
        }
        if ("autoRotateMaxPerHour" in input) {
          if (typeof input.autoRotateMaxPerHour !== "number" || !Number.isFinite(input.autoRotateMaxPerHour))
            return HttpServerResponse.jsonUnsafe(
              { ok: false, error: "autoRotateMaxPerHour must be a number" },
              { status: 400 },
            )
          patch.autoRotateMaxPerHour = input.autoRotateMaxPerHour
        }
        if (Object.keys(patch).length === 0)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "no settings supplied" }, { status: 400 })

        const result = yield* Effect.result(
          Effect.try({
            try: () => OmnicodeSettings.set(patch),
            catch: (cause) => cause,
          }),
        )
        if (result._tag === "Failure")
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `could not write settings: ${String(result.failure)}` },
            { status: 500 },
          )

        return HttpServerResponse.jsonUnsafe(payload())
      }),
    )
  }),
)
