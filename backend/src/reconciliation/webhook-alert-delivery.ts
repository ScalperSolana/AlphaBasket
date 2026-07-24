import { createHmac } from "node:crypto";

import type { OutboxDeliveryPort, OutboxEvent } from "../persistence/index.js";
import type { FetchPort } from "../polymarket/http-json.js";

export interface AlertWebhookDestination {
  readonly pagingUrl: string;
  readonly ticketUrl: string;
  readonly hmacSecret: string;
}

function requireHttps(value: string, name: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new TypeError(`${name} must use HTTPS`);
  return parsed.toString();
}

export class ReconciliationWebhookAlertDelivery implements OutboxDeliveryPort {
  private readonly pagingUrl: string;
  private readonly ticketUrl: string;

  public constructor(
    private readonly fetch: FetchPort,
    private readonly destination: AlertWebhookDestination,
  ) {
    this.pagingUrl = requireHttps(destination.pagingUrl, "paging webhook URL");
    this.ticketUrl = requireHttps(destination.ticketUrl, "ticket webhook URL");
    if (destination.hmacSecret.length < 32 || destination.hmacSecret.length > 4_096) throw new RangeError("alert HMAC secret must contain 32-4096 characters");
  }

  public async deliver(event: OutboxEvent): Promise<void> {
    if (event.topic !== "reconciliation.finding.detected") throw new Error(`no outbox delivery route for ${event.topic}`);
    const payload = event.payload;
    if (payload === null || Array.isArray(payload) || typeof payload !== "object") throw new Error("reconciliation alert payload must be an object");
    const severity = (payload as { readonly [key: string]: import("../persistence/outbox.js").JsonValue }).severity;
    if (severity !== "warning" && severity !== "critical") throw new Error("reconciliation alert severity is invalid");
    const body = JSON.stringify({
      version: 1,
      deliveryId: event.id,
      dedupeKey: event.dedupeKey,
      topic: event.topic,
      severity,
      occurredAt: event.occurredAt.toISOString(),
      payload,
    });
    const signature = createHmac("sha256", this.destination.hmacSecret).update(body, "utf8").digest("hex");
    const response = await this.fetch(severity === "critical" ? this.pagingUrl : this.ticketUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-alphabasket-delivery-id": event.id,
        "x-alphabasket-signature": `sha256=${signature}`,
      },
      body,
    });
    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(`alert webhook returned HTTP ${response.status}: ${responseBody.slice(0, 256)}`);
    }
  }
}
