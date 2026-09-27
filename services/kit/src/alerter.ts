/**
 * Webhook alerter (`11` L6: "mainnet was silent for weeks — Neon 402 quota —
 * the monitor had no webhook"). Every keeper/monitor that hits a condition an
 * on-call human needs to see calls `alert()`; it POSTs to `ALERT_WEBHOOK_URL`
 * (a Slack/Discord-style incoming webhook, or any endpoint that accepts a
 * JSON body) so silence is never mistaken for health.
 *
 * Deliberately fire-and-forget-tolerant: a failed alert is logged, not
 * thrown, because a broken webhook must never crash the service it's trying
 * to warn about.
 */
import type { Logger } from "./logger.ts";

export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  service: string;
  severity: AlertSeverity;
  title: string;
  detail?: string;
  fields?: Record<string, unknown>;
}

export interface Alerter {
  alert(a: Alert): Promise<void>;
}

interface Fetcher {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ ok: boolean; status: number }>;
}

/**
 * Builds an alerter. `webhookUrl` is undefined when `ALERT_WEBHOOK_URL` isn't
 * set — the alerter still works (it just logs a warning instead of posting),
 * so a service in local dev doesn't need a webhook to boot, but production
 * config should always set one (enforced by each service's `env` spec, not
 * here — this module stays agnostic about which services require it).
 */
export function createAlerter(opts: { webhookUrl?: string; service: string; logger: Logger; fetchImpl?: Fetcher }): Alerter {
  const { webhookUrl, service, logger } = opts;
  const fetchImpl: Fetcher = opts.fetchImpl ?? (fetch as unknown as Fetcher);

  return {
    async alert(a: Alert) {
      logger.warn(`alert: ${a.title}`, { severity: a.severity, detail: a.detail, ...a.fields });
      if (!webhookUrl) {
        logger.warn("ALERT_WEBHOOK_URL not set — alert only logged, not delivered");
        return;
      }
      const payload = {
        text: `[${a.severity.toUpperCase()}] ${service}: ${a.title}${a.detail ? `\n${a.detail}` : ""}`,
        service,
        severity: a.severity,
        title: a.title,
        detail: a.detail,
        fields: a.fields,
        at: new Date().toISOString(),
      };
      try {
        const res = await fetchImpl(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) logger.error(`webhook responded ${res.status}`, { title: a.title });
      } catch (e) {
        logger.error(`webhook delivery failed: ${e instanceof Error ? e.message : String(e)}`, { title: a.title });
      }
    },
  };
}
