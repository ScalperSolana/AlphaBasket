import type { SqlClient } from "../persistence/sql-client.js";

export type DeploymentMode = "local" | "hybrid_devnet" | "production_canary" | "production";
export type CapitalMode = "mock" | "prefunded_staging" | "live_bridge";

export interface CanaryPolicy {
  readonly deploymentMode: DeploymentMode;
  readonly accountingSolanaCluster: "localnet" | "devnet" | "mainnet-beta";
  readonly capitalSolanaCluster: "localnet" | "devnet" | "mainnet-beta";
  readonly polymarketChainId: number;
  readonly capitalMode: CapitalMode;
  readonly maximumOperationUnits: bigint;
  readonly maximumDailyUnits: bigint;
  readonly allowedBasketIds: ReadonlySet<string>;
  readonly allowedWalletIds: ReadonlySet<string>;
}

export interface CanaryUsageStorePort {
  reserve(request: {
    readonly environment: string;
    readonly operationId: string;
    readonly amountUnits: bigint;
    readonly maximumDailyUnits: bigint;
    readonly now: Date;
  }): Promise<void>;
}

export interface CanaryAuthorization {
  readonly operationId: string;
  readonly basketId: string;
  readonly walletId: string;
  readonly amountUnits: bigint;
  readonly now: Date;
}

export interface FinancialExecutionGuardPort {
  authorize(request: CanaryAuthorization): Promise<void>;
}

export const NOOP_FINANCIAL_EXECUTION_GUARD: FinancialExecutionGuardPort = Object.freeze({
  authorize: async () => undefined,
});

export class ProductionCanaryGuard implements FinancialExecutionGuardPort {
  public constructor(
    private readonly policy: CanaryPolicy,
    private readonly usage: CanaryUsageStorePort,
  ) {
    if (policy.polymarketChainId !== 137) throw new Error("Polymarket execution must use Polygon mainnet chain 137");
    if (policy.maximumOperationUnits <= 0n || policy.maximumDailyUnits < policy.maximumOperationUnits) {
      throw new Error("canary daily units must be at least the positive per-operation limit");
    }
    if (
      policy.deploymentMode === "hybrid_devnet" &&
      (
        policy.accountingSolanaCluster !== "devnet" ||
        policy.capitalSolanaCluster !== "mainnet-beta" ||
        policy.capitalMode !== "live_bridge"
      )
    ) {
      throw new Error(
        "hybrid_devnet requires accounting Solana devnet, capital Solana mainnet-beta, and live bridge capital",
      );
    }
    if (
      (policy.deploymentMode === "production_canary" || policy.deploymentMode === "production") &&
      (
        policy.accountingSolanaCluster !== "mainnet-beta" ||
        policy.capitalSolanaCluster !== "mainnet-beta"
      )
    ) {
      throw new Error("production modes require accounting and capital Solana mainnet-beta");
    }
    if ((policy.deploymentMode === "production_canary" || policy.deploymentMode === "production") && policy.capitalMode !== "live_bridge") {
      throw new Error("production modes require live_bridge capital");
    }
    if (policy.capitalMode === "live_bridge" && policy.capitalSolanaCluster !== "mainnet-beta") {
      throw new Error("live bridge capital requires capital Solana mainnet-beta");
    }
  }

  public async authorize(request: CanaryAuthorization): Promise<void> {
    if (
      this.policy.deploymentMode !== "production_canary" &&
      this.policy.deploymentMode !== "hybrid_devnet"
    ) return;
    if (request.amountUnits <= 0n || request.amountUnits > this.policy.maximumOperationUnits) {
      throw new Error("canary operation exceeds the per-operation capital limit");
    }
    if (!this.policy.allowedBasketIds.has(request.basketId) || !this.policy.allowedWalletIds.has(request.walletId)) {
      throw new Error("canary basket or execution wallet is not allowlisted");
    }
    await this.usage.reserve({
      environment: this.policy.deploymentMode,
      operationId: request.operationId,
      amountUnits: request.amountUnits,
      maximumDailyUnits: this.policy.maximumDailyUnits,
      now: request.now,
    });
  }
}

export class PostgresCanaryUsageStore implements CanaryUsageStorePort {
  public constructor(private readonly sql: SqlClient) {}

  public async reserve(request: {
    readonly environment: string;
    readonly operationId: string;
    readonly amountUnits: bigint;
    readonly maximumDailyUnits: bigint;
    readonly now: Date;
  }): Promise<void> {
    if (request.amountUnits <= 0n || request.maximumDailyUnits <= 0n) throw new RangeError("canary amounts must be positive");
    await this.sql.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1441702613))", [request.environment]);
      const existing = await transaction.query<{ amount_units: string }>(
        `SELECT amount_units::text AS amount_units FROM canary_budget_usage
         WHERE environment = $1 AND operation_id = $2`,
        [request.environment, request.operationId],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (BigInt(replay.amount_units) !== request.amountUnits) throw new Error("canary operation id reused with a different amount");
        return;
      }
      const used = await transaction.query<{ total: string }>(
        `SELECT COALESCE(sum(amount_units), 0)::text AS total
         FROM canary_budget_usage
         WHERE environment = $1 AND usage_day = ($2 AT TIME ZONE 'UTC')::date`,
        [request.environment, request.now],
      );
      const total = BigInt(used.rows[0]?.total ?? "0") + request.amountUnits;
      if (total > request.maximumDailyUnits) throw new Error("canary daily capital limit exceeded");
      await transaction.query(
        `INSERT INTO canary_budget_usage (
           environment, usage_day, operation_id, amount_units, recorded_at
         ) VALUES ($1, ($2 AT TIME ZONE 'UTC')::date, $3, $4::numeric, $2)`,
        [request.environment, request.now, request.operationId, request.amountUnits.toString(10)],
      );
    }, { isolation: "serializable" });
  }
}
