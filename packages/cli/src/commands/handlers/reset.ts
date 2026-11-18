import { Service } from "@opencode/client/effect/service"
import { Effect } from "effect"
import { EOL } from "node:os"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { errorMessage } from "../../util/error"

type ResetResponse = {
  readonly ok?: boolean
  readonly error?: string
  readonly [key: string]: unknown
}

const handler = Effect.fn("cli.reset")(function* (input: Runtime.Input<typeof Commands.commands.reset>) {
  const server = yield* ServerConnection.resolve()
  const url = new URL("/_omnicode/reset-limits", server.endpoint.url)
  if (input.deep || input.nukeCredentials) {
    url.searchParams.set("mode", "fresh")
    url.searchParams.set("deep", "1")
  }
  if (input.nukeCredentials) url.searchParams.set("nuke-credentials", "1")

  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(url, {
        method: "POST",
        headers: Service.headers(server.endpoint),
        signal: AbortSignal.timeout(input.deep || input.nukeCredentials ? 180_000 : 30_000),
      }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
  const text = yield* Effect.promise(() => response.text())
  const body = parseBody(text)
  if (!response.ok || (typeof body === "object" && body !== null && (body as ResetResponse).ok === false)) {
    process.exitCode = 1
  }
  process.stdout.write(JSON.stringify(body, null, 2) + EOL)
})

export default Runtime.handler(Commands.commands.reset, (input) =>
  handler(input).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        process.stderr.write(errorMessage(error) + EOL)
        process.exitCode = 1
      }),
    ),
  ),
)

function parseBody(text: string) {
  if (text.length === 0) return { ok: true }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { ok: false, error: text }
  }
}
