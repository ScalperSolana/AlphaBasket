import type { SqlClient } from "../persistence/sql-client.js";
import type {
  ExecutionWalletDescriptor,
  ExecutionWalletRegistryPort,
  ExecutionWalletStatus,
  WalletAssignment,
  WalletAssignmentStorePort,
} from "./types.js";

interface WalletRow extends Record<string, unknown> {
  wallet_id: string;
  polygon_address: string;
  shard: string;
  status: ExecutionWalletStatus;
}

interface AssignmentRow extends Record<string, unknown> {
  basket_id: string;
  wallet_id: string;
  shard: string;
  strategy_version: string;
  assigned_at_ms: string;
}

const mapAssignment = (row: AssignmentRow): WalletAssignment =>
  Object.freeze({
    basketId: row.basket_id,
    walletId: row.wallet_id,
    shard: row.shard,
    strategyVersion: row.strategy_version,
    assignedAtMs: BigInt(row.assigned_at_ms),
  });

export class PostgresExecutionWalletRegistry
  implements ExecutionWalletRegistryPort
{
  public constructor(private readonly sql: SqlClient) {}

  public async listWallets(): Promise<readonly ExecutionWalletDescriptor[]> {
    const result = await this.sql.query<WalletRow>(
      `SELECT wallet_id, polygon_address, shard, status
       FROM execution_wallets ORDER BY wallet_id`,
    );
    return Object.freeze(
      result.rows.map((row) =>
        Object.freeze({
          walletId: row.wallet_id,
          polygonAddress: row.polygon_address,
          shard: row.shard,
          status: row.status,
        }),
      ),
    );
  }
}

export class PostgresWalletAssignmentStore
  implements WalletAssignmentStorePort
{
  public constructor(private readonly sql: SqlClient) {}

  public async findByBasketId(basketId: string): Promise<WalletAssignment | null> {
    const result = await this.sql.query<AssignmentRow>(
      `SELECT basket_id, wallet_id, shard, strategy_version,
              assigned_at_ms::text AS assigned_at_ms
       FROM wallet_assignments WHERE basket_id = $1`,
      [basketId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapAssignment(row);
  }

  public async putIfAbsent(candidate: WalletAssignment): Promise<WalletAssignment> {
    if (candidate.assignedAtMs < 0n) {
      throw new RangeError("assignedAtMs must be non-negative");
    }
    await this.sql.query(
      `INSERT INTO wallet_assignments (
         basket_id, wallet_id, shard, strategy_version, assigned_at_ms
       ) VALUES ($1, $2, $3, $4, $5::numeric)
       ON CONFLICT (basket_id) DO NOTHING`,
      [
        candidate.basketId,
        candidate.walletId,
        candidate.shard,
        candidate.strategyVersion,
        candidate.assignedAtMs.toString(10),
      ],
    );
    const persisted = await this.findByBasketId(candidate.basketId);
    if (persisted === null) {
      throw new Error("wallet assignment disappeared after insert");
    }
    return persisted;
  }
}
