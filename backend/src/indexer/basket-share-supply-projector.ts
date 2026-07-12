import { createHash } from "node:crypto";

import type { BasketShareSupplyProjectionWriterPort } from "../nav/types.js";
import type {
  AccountProjectionSinkPort,
  IndexedAccountRecord,
} from "./types.js";

const decimalBigint = (value: unknown, field: string): bigint => {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`decoded basket.${field} must be a decimal integer string`);
  }
  return BigInt(value);
};

/** Projects the finalized Basket account fields required for management-fee-aware NAV. */
export class BasketShareSupplyAccountProjector
  implements AccountProjectionSinkPort
{
  public constructor(
    private readonly accounts: AccountProjectionSinkPort,
    private readonly supplies: BasketShareSupplyProjectionWriterPort,
  ) {}

  public async applySnapshotMonotonic(
    programId: string,
    sourceSlot: bigint,
    records: readonly IndexedAccountRecord[],
  ): Promise<void> {
    await this.accounts.applySnapshotMonotonic(programId, sourceSlot, records);
    for (const record of records) {
      if (record.kind !== "basket") continue;
      const totalSharesUnits = decimalBigint(
        record.data.totalSharesOutstanding,
        "totalSharesOutstanding",
      );
      const protocolFeeSharesUnits = decimalBigint(
        record.data.protocolFeeShares,
        "protocolFeeShares",
      );
      const lastManagementFeeAtSeconds = decimalBigint(
        record.data.lastManagementFeeAt,
        "lastManagementFeeAt",
      );
      const managementFeeAccrualRemainder = decimalBigint(
        record.data.managementFeeAccrualRemainder,
        "managementFeeAccrualRemainder",
      );
      const sourceVersion = createHash("sha256")
        .update(
          JSON.stringify([
            "alphabasket-share-supply-v1",
            record.address,
            sourceSlot.toString(10),
            totalSharesUnits.toString(10),
            protocolFeeSharesUnits.toString(10),
            lastManagementFeeAtSeconds.toString(10),
            managementFeeAccrualRemainder.toString(10),
          ]),
          "utf8",
        )
        .digest("hex");
      await this.supplies.upsertShareSupply(
        record.address,
        Object.freeze({
          totalSharesUnits,
          protocolFeeSharesUnits,
          lastManagementFeeAtSeconds,
          managementFeeAccrualRemainder,
          sourceSlot,
          sourceVersion,
        }),
      );
    }
  }
}
