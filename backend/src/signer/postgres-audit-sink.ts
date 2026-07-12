import type { SqlExecutor } from "../persistence/sql-client.js";
import type { SignerAuditEvent, SignerAuditSink } from "./types.js";

export class PostgresSignerAuditSink implements SignerAuditSink {
  public constructor(private readonly sql: SqlExecutor) {}

  public async record(event: SignerAuditEvent): Promise<void> {
    await this.sql.query(
      `INSERT INTO signer_audit_log (
         id, role, key_reference, algorithm, domain, action, network,
         payload_hash, payload_bytes, outcome, reason, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        event.id,
        event.role,
        event.keyReference ?? null,
        event.algorithm ?? null,
        event.domain,
        event.action,
        event.network,
        event.payloadHash,
        event.payloadBytes,
        event.outcome,
        event.reason ?? null,
        event.occurredAt,
      ],
    );
  }
}
