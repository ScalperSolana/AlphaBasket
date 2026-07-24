import type { OutboxEvent, TransactionalOutboxRepository } from "./outbox.js";

export interface OutboxDeliveryPort {
  deliver(event: OutboxEvent): Promise<void>;
}

export interface OutboxDispatcherResult {
  readonly claimed: number;
  readonly published: number;
  readonly released: number;
}

export class OutboxDispatcher {
  public constructor(
    private readonly outbox: TransactionalOutboxRepository,
    private readonly delivery: OutboxDeliveryPort,
    private readonly options: Readonly<{
      ownerId: string;
      batchSize: number;
      leaseDurationMs: number;
      maximumAttempts: number;
      retryBaseMs: number;
    }>,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (options.ownerId.length === 0 || options.ownerId.length > 256) throw new RangeError("invalid outbox owner ID");
    for (const [name, value] of Object.entries({
      batchSize: options.batchSize,
      leaseDurationMs: options.leaseDurationMs,
      maximumAttempts: options.maximumAttempts,
      retryBaseMs: options.retryBaseMs,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
    }
  }

  public async runOnce(): Promise<OutboxDispatcherResult> {
    const lease = await this.outbox.claim({
      owner: this.options.ownerId,
      limit: this.options.batchSize,
      leaseDurationMs: this.options.leaseDurationMs,
      maxAttempts: this.options.maximumAttempts,
    });
    let published = 0;
    let released = 0;
    for (const event of lease.events) {
      try {
        await this.delivery.deliver(event);
        const changed = await this.outbox.markPublished([event.id], lease.owner, lease.token);
        if (changed !== 1) throw new Error("outbox lease was lost before publish acknowledgement");
        published += 1;
      } catch (error) {
        const exponent = Math.min(event.attempts - 1, 10);
        const retryMs = this.options.retryBaseMs * (2 ** exponent);
        const changed = await this.outbox.release({
          eventIds: [event.id],
          owner: lease.owner,
          token: lease.token,
          retryAt: new Date(this.now().getTime() + retryMs),
          error: (error instanceof Error ? error.message : "unknown outbox delivery failure").slice(0, 2_048),
        });
        if (changed !== 1) throw new Error("outbox lease was lost before retry release", { cause: error });
        released += 1;
      }
    }
    return Object.freeze({ claimed: lease.events.length, published, released });
  }
}
