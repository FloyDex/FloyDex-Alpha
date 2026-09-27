/**
 * Order intake: a small HTTP service (not Next.js yet — Phase 4 owns the
 * app). `POST /orders` verifies the session-key signature over the 108-byte
 * order message, confirms the signer is the account's active on-chain
 * delegate, and stores the order for the matcher to pick up.
 *
 * Ported from the intent of `reference/stellar/frontend/app/api/orders/route.ts`
 * (rate-limit first, validate before touching the DB, never leak internals),
 * rebuilt for plain `node:http` and the Solana wire format/signature.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import type { PrismaClient } from "@kryon/db";
import type { Logger } from "../../kit/src/logger.ts";
import type { Alerter } from "../../kit/src/alerter.ts";
import { validateOrderPayload } from "./validate.ts";
import { assertDelegateActive } from "./delegate.ts";

const MAX_BODY_BYTES = 8192;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

export interface IntakeDeps {
  connection: Connection;
  prisma: PrismaClient;
  idl: Idl;
  programId: PublicKey;
  domain: Uint8Array;
  logger: Logger;
  alerter: Alerter;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(buf.length) });
  res.end(buf);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Single-process, per-instance rate limiting. Unlike the Stellar route this
 * is ported from (`11` L16: an in-memory limiter silently no-ops under
 * horizontal scale on serverless), this service is a long-running Node
 * process, not a fleet of stateless isolates, so an in-memory bucket per
 * (owner, IP) is a real limit, not a false one. Revisit if this ever runs
 * behind more than one instance.
 */
class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  allow(key: string, limit: number): boolean {
    const now = Date.now();
    if (this.buckets.size > 10_000) {
      for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
    }
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }
}

export function requestKey(req: IncomingMessage, owner: string): string {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  return `${owner}:${ip}`;
}

export function createServer(deps: IntakeDeps) {
  const limiter = new RateLimiter();
  const log = deps.logger.child({ route: "orders" });

  return createHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
    if (req.method !== "POST" || req.url !== "/orders") return json(res, 404, { ok: false, error: "not found" });

    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return json(res, 413, { ok: false, error: "body too large" });
    }

    const raw = await readBody(req, MAX_BODY_BYTES);
    if (raw === null) return json(res, 413, { ok: false, error: "body too large" });

    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return json(res, 400, { ok: false, error: "invalid JSON body" });
    }

    // Rate-limit BEFORE signature verification, same reasoning as the
    // Stellar route: an attacker shouldn't get free ed25519-verify CPU on
    // junk requests. The owner field is taken as-is for the limiter key;
    // validateOrderPayload re-checks it fully.
    const claimedOwner = typeof (body as Record<string, unknown>)?.owner === "string" ? ((body as Record<string, unknown>).owner as string).slice(0, 64) : "invalid";
    if (!limiter.allow(requestKey(req, claimedOwner), MAX_REQUESTS_PER_WINDOW)) {
      return json(res, 429, { ok: false, error: "too many order requests" });
    }

    const result = validateOrderPayload(body, deps.domain);
    if (!result.ok) return json(res, 400, { ok: false, error: result.error });
    const o = result.order;

    const market = await deps.prisma.market.findUnique({ where: { id: o.marketId } });
    if (!market || !market.active) return json(res, 400, { ok: false, error: `market ${o.marketId} is not known or not active` });

    let delegateCheck;
    try {
      delegateCheck = await assertDelegateActive({
        connection: deps.connection,
        idl: deps.idl,
        programId: deps.programId,
        owner: new PublicKey(o.owner),
        subId: o.subId,
        signerPubkey: new PublicKey(o.signerPubkey),
      });
    } catch (e) {
      log.error("delegate check failed", { error: e instanceof Error ? e.message : String(e) });
      return json(res, 502, { ok: false, error: "could not verify delegate on-chain" });
    }
    if (!delegateCheck.ok) return json(res, 403, { ok: false, error: delegateCheck.error });
    if (o.nonce < delegateCheck.cancelAllBelowNonce) {
      return json(res, 400, { ok: false, error: "nonce was cancelled by a prior cancel_all_below_nonce" });
    }

    try {
      await deps.prisma.account.upsert({ where: { address: o.owner }, create: { address: o.owner }, update: {} });
      await deps.prisma.order.upsert({
        where: { owner_subId_nonce: { owner: o.owner, subId: o.subId, nonce: o.nonce } },
        create: {
          id: `${o.owner}:${o.subId}:${o.nonce.toString()}`,
          owner: o.owner,
          subId: o.subId,
          marketId: o.marketId,
          isLong: o.isLong,
          size: o.size.toString(),
          limitPrice: o.limitPrice.toString(),
          reduceOnly: o.reduceOnly,
          nonce: o.nonce,
          expiryTs: o.expiryTs,
          signature: o.signature,
        },
        update: {},
      });
    } catch (e) {
      log.error("order intake DB error", { error: e instanceof Error ? e.message : String(e) });
      await deps.alerter.alert({ service: "order-intake", severity: "warning", title: "order intake DB error", detail: e instanceof Error ? e.message : String(e) });
      return json(res, 500, { ok: false, error: "failed to persist order" });
    }

    return json(res, 200, { ok: true });
  });
}
