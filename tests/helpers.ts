import postgres from "postgres";
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Cell } from "@kuber/core";
import { MemoryKms } from "@kuber/crypto";
import { systemGrants } from "@kuber/eventstore";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const POLICY_DIR = join(ROOT, "policies");
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://kuber@localhost:5433/postgres";

export const APP_ROLE = "kuber_app";
export const SYSTEM_ROLE = "kuber_system";
const SYSTEM_PASSWORD = process.env.TEST_SYSTEM_DB_PASSWORD ?? SYSTEM_ROLE;

/**
 * A fresh database per test file, dropped afterwards. `ownerUrl` runs migrations; `url` is the
 * application role, which is neither superuser nor BYPASSRLS so row-level security applies.
 */
export async function freshDatabase(): Promise<{ url: string; ownerUrl: string; systemUrl: string; drop: () => Promise<void> }> {
  const name = `kuber_test_${randomBytes(4).toString("hex")}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${(process.env.TEST_APP_DB_PASSWORD ?? APP_ROLE).replace(/'/g, "")}' NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN_URL);                      // keep credentials and ?sslmode=… of the admin URL
  u.pathname = `/${name}`;
  const ownerUrl = u.toString();
  // Same credentials as deploy/postgres-init.sql, so tests run against the Docker Postgres too.
  const app = new URL(ownerUrl); app.username = APP_ROLE; app.password = process.env.TEST_APP_DB_PASSWORD ?? APP_ROLE;
  const url = app.toString();
  // The system role is created by migrateCell (Cell.start with systemRole).
  const sys = new URL(ownerUrl); sys.username = SYSTEM_ROLE; sys.password = SYSTEM_PASSWORD;
  const systemUrl = sys.toString();
  return {
    url, ownerUrl, systemUrl,
    drop: async () => {
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Create (or reuse) the system login role and grant it system scope on `schemas`, as migrateCell does. */
export async function grantSystemRole(owner: postgres.Sql, schemas: string[]) {
  await owner.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SYSTEM_ROLE}') THEN
    CREATE ROLE ${SYSTEM_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
  await owner.unsafe(`ALTER ROLE ${SYSTEM_ROLE} PASSWORD '${SYSTEM_PASSWORD.replace(/'/g, "")}'`);
  await owner.unsafe(systemGrants(SYSTEM_ROLE, schemas));
}

export async function startCell(clockDate: { value: string }, extra: Partial<Parameters<typeof Cell.start>[0]> = {}) {
  const db = await freshDatabase();
  const cell = await Cell.start({ databaseUrl: db.url, migrationUrl: db.ownerUrl, appRole: APP_ROLE, policyDir: POLICY_DIR,
    systemDatabaseUrl: db.systemUrl, systemRole: { name: SYSTEM_ROLE, password: SYSTEM_PASSWORD },
    clock: () => clockDate.value, kms: new MemoryKms(), ...extra });
  return { cell, db, stop: async () => { await cell.close(); await db.drop(); } };
}

// ---------------------------------------------------------------- identity (F01/F02)
import type { FastifyInstance, InjectOptions } from "fastify";
import { AUTH_HEADER, authKey, signRequest } from "@kuber/auth";

/** Shared BFF-core secret for tests: pass as buildServer(cell, { auth: { secret: CORE_AUTH_SECRET } }). */
export const CORE_AUTH_SECRET = "test-core-auth-secret-0123456789abcdef";

/** Make principals active members of a tenant (owner, controller, ... or agent:<name>), optionally book-scoped. */
export async function enrol(cell: Cell, tenant: string, principals: string[], books: string[] | null = null) {
  for (const principal of principals) await cell.identity.addMember(tenant, "operator:test", { principal, books });
}

export interface SignedRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; tenant: string | null; principal: string | null;
  payload?: unknown; contentType?: string; headers?: Record<string, string>;
  /** Web session id; a fresh random one for requests with a principal unless given (null: none). */
  session?: string | null;
  /** The BFF's step-up claim: when the person last confirmed with their passkey (epoch ms). */
  stepUpAt?: number;
}
/** A random web session id, as the BFF issues at sign-in. */
export const newSession = () => randomBytes(24).toString("base64url");
/** app.inject, signed the way the BFF signs requests to the core. */
export function signedInject(app: FastifyInstance, secret = CORE_AUTH_SECRET) {
  const key = authKey(secret);
  return (r: SignedRequest) => {
    const body = r.payload === undefined ? undefined : typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload);
    const headers: Record<string, string> = {
      [AUTH_HEADER]: signRequest(key, { method: r.method, path: r.url, body, tenant: r.tenant, principal: r.principal,
        session: r.session !== undefined ? r.session : r.principal ? newSession() : null, stepUpAt: r.stepUpAt }),
      ...(body !== undefined ? { "content-type": r.contentType ?? "application/json" } : {}), ...r.headers,
    };
    return app.inject({ method: r.method, url: r.url, headers, ...(body !== undefined ? { payload: body } : {}) } as InjectOptions);
  };
}

/**
 * Sign an inject request written in the old header style: `x-kuber-tenant` / `x-kuber-principal`
 * become the signed assertion's tenant and principal (and are removed), the payload is serialized
 * once and its exact bytes signed. Everything else (other headers, body) is sent unchanged.
 */
export function signed(r: { method: string; url: string; headers?: Record<string, string | undefined>; payload?: unknown }, secret = CORE_AUTH_SECRET): InjectOptions {
  const { "x-kuber-tenant": tenant, "x-kuber-principal": principal, ...headers } = r.headers ?? {};
  const body = r.payload === undefined ? undefined : typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload);
  const out: Record<string, string> = Object.fromEntries(Object.entries(headers).filter((e): e is [string, string] => e[1] !== undefined));
  if (body !== undefined && !Object.keys(out).some((k) => k.toLowerCase() === "content-type")) out["content-type"] = "application/json";
  out[AUTH_HEADER] = signRequest(authKey(secret), { method: r.method, path: r.url, body, tenant: tenant ?? null, principal: principal ?? null,
    session: principal ? newSession() : null });
  return { method: r.method, url: r.url, headers: out, ...(body !== undefined ? { payload: body } : {}) } as InjectOptions;
}

// ---------------------------------------------------------------- passkeys with a software authenticator
/**
 * A software WebAuthn authenticator: an ES256 (P-256) key pair, authenticatorData and
 * clientDataJSON built by hand, "none" attestation. `get` signs whatever challenge the options
 * carry (for signed commands: the command digest), with user presence and verification set.
 */
export const ORIGIN = "http://localhost:3000", RP_ID = "localhost";
export const b64u = (b: Uint8Array | Buffer | string) => Buffer.from(b as Uint8Array).toString("base64url");
export function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n])
    : n < 65536 ? Buffer.from([(major << 5) | 25, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b; })();
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  const o = v as Record<string, unknown>;
  return Buffer.concat([head(5, Object.keys(o).length), ...Object.entries(o).flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}
export class SoftAuthenticator {
  private key: KeyObject; readonly credId = randomBytes(32); private count = 0; readonly cose: Buffer;
  constructor(private origin = ORIGIN) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  }
  private authData(flags: number, attested?: Buffer) {
    const c = Buffer.alloc(4); c.writeUInt32BE(this.count);
    return Buffer.concat([createHash("sha256").update(RP_ID).digest(), Buffer.from([flags]), c, ...(attested ? [attested] : [])]);
  }
  create(options: { challenge: string }) {
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
    const authData = this.authData(0x45, Buffer.concat([Buffer.alloc(16), len, this.credId, this.cose]));
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cbor({ fmt: "none", attStmt: {}, authData })), transports: ["internal"] } };
  }
  get(options: { challenge: string }) {
    this.count++;
    const authData = this.authData(0x05);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const signature = createSign("sha256").update(Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()])).sign(this.key);
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) } };
  }
}

