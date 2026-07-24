import type { SignerAuditEvent, SignerAuditSink } from "./types.js";

export class InMemorySignerAuditSink implements SignerAuditSink {
  private readonly mutableEvents: SignerAuditEvent[] = [];

  public get events(): readonly SignerAuditEvent[] {
    return this.mutableEvents.map((event) => ({
      ...event,
      occurredAt: new Date(event.occurredAt),
    }));
  }

  public async record(event: SignerAuditEvent): Promise<void> {
    this.mutableEvents.push({
      ...event,
      occurredAt: new Date(event.occurredAt),
    });
  }
}
