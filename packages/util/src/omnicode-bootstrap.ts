export * as OmnicodeBootstrap from "./omnicode-bootstrap.js"

import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { createConnection as netConnect } from "node:net"
import { homedir } from "node:os"
import { dirname as pathDirname, join as pathJoin } from "node:path"
import { installImpersonateFetchOverride } from "./omnicode-impersonate-fetch.js"
import * as OmnicodeSettings from "./omnicode-settings.js"

const TOR_SOCKS_PORT = 9150

process.env.OMNICODE_MCP_DIRECT ??= "1"

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

function shouldRouteThroughTor(hostname: string): boolean {
  if (!hostname) return false
  const h = hostname.toLowerCase()
  return h === "opencode.ai" || h.endsWith(".opencode.ai")
}

async function openSocks5(host: string, port: number, timeoutMs = 20_000): Promise<import("node:net").Socket> {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: "127.0.0.1", port: TOR_SOCKS_PORT })
    let step: "greet" | "connect" = "greet"
    let buf = Buffer.alloc(0)
    const t = setTimeout(() => {
      sock.destroy()
      reject(new Error("socks5 timeout"))
    }, timeoutMs)
    sock.once("connect", () => sock.write(Buffer.from([0x05, 0x01, 0x00])))
    sock.on("data", (chunk: Buffer | string) => {
      buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk) : chunk])
      if (step === "greet") {
        if (buf.length < 2) return
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          clearTimeout(t)
          sock.destroy()
          return reject(new Error("socks5 greet rejected"))
        }
        buf = buf.slice(2)
        const domain = Buffer.from(host, "ascii")
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]),
          domain,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ])
        sock.write(req)
        step = "connect"
        return
      }
      if (step === "connect") {
        if (buf.length < 10) return
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          clearTimeout(t)
          sock.destroy()
          return reject(new Error(`socks5 connect rep=${buf[1]}`))
        }
        const atyp = buf[3]
        let addrLen = 0
        if (atyp === 0x01) addrLen = 4
        else if (atyp === 0x04) addrLen = 16
        else if (atyp === 0x03) addrLen = 1 + buf[4]
        else {
          clearTimeout(t)
          sock.destroy()
          return reject(new Error(`socks5 unknown atyp ${atyp}`))
        }
        const total = 4 + addrLen + 2
        if (buf.length < total) return
        const tail = buf.slice(total)
        clearTimeout(t)
        sock.removeAllListeners("data")
        if (tail.length > 0) sock.unshift(tail)
        resolve(sock)
      }
    })
    sock.on("error", (e) => {
      clearTimeout(t)
      reject(e)
    })
  })
}

let _torAgent: import("undici").Agent | null = null
async function torFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const undici = await import("undici")
  const tlsMod = await import("node:tls")
  if (!_torAgent) {
    _torAgent = new undici.Agent({
      connect: (async (
        opts: { hostname?: string; host?: string; port?: number | string; protocol?: string; servername?: string },
        cb: (err: Error | null, sock: import("node:net").Socket | null) => void,
      ) => {
        try {
          const host = opts.hostname ?? opts.host ?? ""
          const port = Number(opts.port ?? 443)
          const protocol = opts.protocol ?? "https:"
          const servername = opts.servername ?? host
          const raw = await openSocks5(host, port, 20_000)
          if (protocol === "https:") {
            const tls = tlsMod.connect({ socket: raw, servername, ALPNProtocols: ["http/1.1"] })
            const onSecure = () => {
              tls.removeListener("error", onErr)
              cb(null, tls as unknown as import("node:net").Socket)
            }
            const onErr = (e: Error) => {
              tls.removeListener("secureConnect", onSecure)
              cb(e, null)
            }
            tls.once("secureConnect", onSecure)
            tls.once("error", onErr)
          } else {
            cb(null, raw)
          }
        } catch (e) {
          cb(e as Error, null)
        }
      }) as never,
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 20_000,
      pipelining: 0,
    } as never)
  }
  const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
  diag(`[bootstrap-torFetch] -> ${urlStr?.slice(0, 160)}`)
  const res = (await (
    undici as unknown as {
      fetch: (
        u: RequestInfo | URL,
        init?: RequestInit & { dispatcher?: import("undici").Dispatcher },
      ) => Promise<Response>
    }
  ).fetch(input, { ...init, dispatcher: _torAgent })) as Response
  diag(`[bootstrap-torFetch] <- status=${res.status}`)
  return res
}

;(function reportProxyState() {
  try {
    const envHttps = process.env.HTTPS_PROXY || process.env.https_proxy
    const envHttp = process.env.HTTP_PROXY || process.env.http_proxy
    const envAll = process.env.ALL_PROXY || process.env.all_proxy
    const target = envHttps || envHttp || envAll
    const torForced = OmnicodeSettings.resolved().forceTor
    if (target) {
      diag(`[bootstrap-proxy] bun native fetch will use proxy=${target} (no undici needed)`)
      return
    }
    if (torForced) {
      diag(
        `[bootstrap-proxy] no HTTPS_PROXY env but Tor routing is enabled — Tor SOCKS5 override will carry opencode.ai traffic`,
      )
      return
    }
    diag(`[bootstrap-proxy] no HTTPS_PROXY/HTTP_PROXY/ALL_PROXY env, no OMNICODE_FORCE_TOR`)
    if (process.env.OMNICODE_REQUIRE_PROXY === "1") {
      diag(`[bootstrap-proxy] FAIL-CLOSED: OMNICODE_REQUIRE_PROXY=1 and no proxy env; exiting`)
      try {
        process.stderr.write(
          "omnicode-bootstrap: egress not protected (OMNICODE_REQUIRE_PROXY=1 and no HTTPS_PROXY / OMNICODE_FORCE_TOR)\n",
        )
      } catch {
        /* ignore */
      }
      process.exit(17)
    }
  } catch (e) {
    diag(`[bootstrap-proxy] reporter failed: ${(e as Error).message}`)
  }
})()

;(function patchEarly() {
  try {
    if (!OmnicodeSettings.resolved().forceTor) {
      diag(
        `[bootstrap-fetch] disabled (enable Tor routing in settings or set OMNICODE_FORCE_TOR=1). HTTPS_PROXY env (when configured) handles egress via the proxy.`,
      )
      return
    }
    if (typeof globalThis.fetch !== "function") return
    if ((globalThis as { __omnicodeFetchPatched?: boolean }).__omnicodeFetchPatched) return
    const original = globalThis.fetch.bind(globalThis)
    ;(globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
        const host = new URL(url).hostname.toLowerCase()
        if (shouldRouteThroughTor(host)) {
          diag(`[bootstrap-fetch] routing ${host} through torFetch (OMNICODE_FORCE_TOR=1)`)
          return await torFetch(input, init)
        }
      } catch (e) {
        diag(`[bootstrap-fetch] ERROR: ${(e as Error).message}, falling through to native`)
      }
      return original(input as RequestInfo | URL, init)
    }) as typeof globalThis.fetch
    ;(globalThis as { __omnicodeFetchPatched?: boolean }).__omnicodeFetchPatched = true
    diag(`[bootstrap-fetch] EARLY patch installed at CLI entry (OMNICODE_FORCE_TOR=1)`)
  } catch (e) {
    diag(`[bootstrap-fetch] FAILED to install: ${(e as Error).message}`)
  }
  void readFileSync
})()

;(function patchImpersonate() {
  try {
    const result = installImpersonateFetchOverride()
    diag(`[bootstrap-impersonate] install result: ${JSON.stringify(result)}`)
  } catch (e) {
    diag(`[bootstrap-impersonate] FAILED: ${(e as Error).message}`)
  }
})()
