/**
 * Shared replay protection for several core instances: accepted nonces live in Valkey (or Redis),
 * claimed with one atomic `SET <prefix><nonce> 1 NX PX <ms until the assertion expires>`. The
 * first instance to see a nonce wins; every other instance, and every later request, sees a replay.
 *
 * A minimal RESP client over node:net / node:tls (one pipelined connection, AUTH on connect,
 * reconnect on the next command after a failure), so neither tier needs a client library.
 * Configuration (see replayStoreFromEnv):
 *   VALKEY_URL       rediss://[user[:password]@]host:6379[/db]   (valkeys://, redis:// and valkey:// also work;
 *                    REDIS_URL is read when VALKEY_URL is unset)
 *   VALKEY_PASSWORD  password when not in the URL (docker-compose sets requirepass from it)
 *   VALKEY_TLS_CA    CA file for a private CA (NODE_EXTRA_CA_CERTS also applies)
 * Without a URL the in-process ReplayCache is used, which is correct for one core instance only.
 */
import { readFileSync } from "node:fs";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { ReplayCache, type ReplayStore } from "./index.ts";

/** Something that runs one Valkey command and returns its reply (a fake in tests). */
export interface RespClient {
  command(args: string[]): Promise<unknown>;
  close?(): Promise<void>;
}

export class RespError extends Error {}

export interface ValkeyOptions {
  host: string; port: number; tls: boolean;
  username?: string; password?: string; db?: number;
  ca?: Buffer; servername?: string;
  /** Per-command timeout; a command that times out closes the connection (replies would be out of order). */
  timeoutMs?: number;
}

/** Parse a valkey:// / redis:// (plain) or valkeys:// / rediss:// (TLS) URL. */
export function parseValkeyUrl(url: string): ValkeyOptions {
  const u = new URL(url);
  const tls = u.protocol === "rediss:" || u.protocol === "valkeys:";
  if (!tls && u.protocol !== "redis:" && u.protocol !== "valkey:") throw new Error(`unsupported Valkey URL scheme ${u.protocol}`);
  const db = u.pathname.replace(/^\//, "");
  return {
    host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || 6379), tls,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(db ? { db: Number(db) } : {}),
  };
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** RESP2/3 reply parser: returns [value, next offset], or null when the buffer holds no complete reply yet. */
export function parseReply(buf: Buffer, at = 0): [unknown, number] | null {
  const eol = buf.indexOf("\r\n", at);
  if (eol < 0) return null;
  const type = String.fromCharCode(buf[at]!), line = buf.toString("utf8", at + 1, eol), next = eol + 2;
  switch (type) {
    case "+": return [line, next];
    case "-": return [new RespError(line), next];
    case ":": return [Number(line), next];
    case "_": return [null, next];
    case "$": {
      const n = Number(line);
      if (n < 0) return [null, next];
      if (buf.length < next + n + 2) return null;
      return [buf.toString("utf8", next, next + n), next + n + 2];
    }
    case "*": {
      const n = Number(line);
      if (n < 0) return [null, next];
      const out: unknown[] = [];
      let p = next;
      for (let k = 0; k < n; k++) {
        const r = parseReply(buf, p);
        if (!r) return null;
        out.push(r[0]); p = r[1];
      }
      return [out, p];
    }
    default: throw new RespError(`unexpected reply type ${JSON.stringify(type)}`);
  }
}

export const encodeCommand = (args: string[]) =>
  Buffer.concat([Buffer.from(`*${args.length}\r\n`), ...args.flatMap((a) => { const b = Buffer.from(a, "utf8"); return [Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n")]; })]);

export class ValkeyClient implements RespClient {
  private sock: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private pending: Pending[] = [];
  private closed = false;
  constructor(private o: ValkeyOptions) {}

  async command(args: string[]): Promise<unknown> {
    if (this.closed) throw new Error("valkey client is closed");
    return this.send(await this.open(), args);
  }

  async close() {
    this.closed = true;
    const s = this.sock;
    this.sock = null;
    if (s) await new Promise<void>((resolve) => { s.once("close", () => resolve()); s.end(); setTimeout(() => { s.destroy(); resolve(); }, 500).unref(); });
  }

  private send(s: Socket, args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(s, new Error(`valkey did not answer ${args[0]} within ${this.o.timeoutMs ?? 2000} ms`)), this.o.timeoutMs ?? 2000);
      timer.unref();
      this.pending.push({
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      s.write(encodeCommand(args));
    });
  }

  private open(): Promise<Socket> {
    if (this.sock) return Promise.resolve(this.sock);
    if (this.connecting) return this.connecting;
    const o = this.o;
    const p = new Promise<Socket>((resolve, reject) => {
      const s = o.tls
        ? tlsConnect({ host: o.host, port: o.port, ...(o.ca ? { ca: o.ca } : {}), ...(isIP(o.host) ? {} : { servername: o.servername ?? o.host }), minVersion: "TLSv1.2" })
        : netConnect({ host: o.host, port: o.port });
      s.setNoDelay(true);
      let ready = false;
      s.on("data", (d: Buffer) => this.onData(d));
      s.on("error", (e) => { if (!ready) reject(e); this.fail(s, e); });
      s.on("close", () => { if (!ready) reject(new Error("valkey connection closed")); this.fail(s, new Error("valkey connection closed")); });
      s.once(o.tls ? "secureConnect" : "connect", async () => {
        this.sock = s;
        try {
          if (o.password !== undefined) await this.send(s, o.username ? ["AUTH", o.username, o.password] : ["AUTH", o.password]).then(check);
          if (o.db) await this.send(s, ["SELECT", String(o.db)]).then(check);
          ready = true;
          resolve(s);
        } catch (e) { reject(e as Error); this.fail(s, e as Error); }
      });
    }).finally(() => { this.connecting = null; });
    this.connecting = p;
    return p;
  }

  private onData(d: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    let at = 0;
    for (;;) {
      let r: [unknown, number] | null;
      try { r = parseReply(this.buf, at); } catch (e) { if (this.sock) this.fail(this.sock, e as Error); return; }
      if (!r) break;
      at = r[1];
      const p = this.pending.shift();
      if (p) (r[0] instanceof RespError ? p.reject(r[0]) : p.resolve(r[0]));
    }
    this.buf = at >= this.buf.length ? Buffer.alloc(0) : this.buf.subarray(at);
  }

  /** Drop the connection and fail everything waiting on it; the next command reconnects. */
  private fail(s: Socket, e: Error) {
    s.destroy();
    if (this.sock !== null && this.sock !== s) return;        // an earlier connection: nothing waits on it any more
    this.sock = null;
    this.buf = Buffer.alloc(0);
    const waiting = this.pending;
    this.pending = [];
    for (const p of waiting) p.reject(e);
  }
}

const check = (r: unknown) => { if (r !== "OK") throw new RespError(`unexpected reply ${JSON.stringify(r)}`); return r; };

/** Nonces claimed in Valkey: `SET NX PX` is atomic, so exactly one claim of a nonce succeeds across all instances. */
export class ValkeyReplayStore implements ReplayStore {
  readonly kind = "valkey";
  constructor(private client: RespClient, private prefix = "kuber:auth:nonce:") {}
  async claim(nonce: string, expiresAt: number, now = Date.now()): Promise<boolean> {
    const ttl = Math.max(1, Math.ceil(expiresAt - now));
    const r = await this.client.command(["SET", this.prefix + nonce, "1", "NX", "PX", String(ttl)]);
    if (r === "OK") return true;
    if (r === null) return false;
    throw new RespError(`unexpected reply to SET NX: ${JSON.stringify(r)}`);
  }
  async close() { await this.client.close?.(); }
}

/**
 * The replay store for this process: Valkey when VALKEY_URL (or REDIS_URL) is set, otherwise the
 * in-process cache (one instance only; the default for development and tests).
 */
export function replayStoreFromEnv(env: Record<string, string | undefined> = process.env): ReplayStore {
  const url = env.VALKEY_URL || env.REDIS_URL;
  if (!url) return new ReplayCache();
  const o = parseValkeyUrl(url);
  if (o.password === undefined && env.VALKEY_PASSWORD) o.password = env.VALKEY_PASSWORD;
  if (env.VALKEY_TLS_CA) o.ca = readFileSync(env.VALKEY_TLS_CA);
  return new ValkeyReplayStore(new ValkeyClient(o));
}
