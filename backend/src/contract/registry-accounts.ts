import { PublicKey } from "@solana/web3.js";

import {
  derivePerpEligibilityListPda,
  deriveTokenAllowlistPda,
} from "./pdas.js";
import { ALPHABASKET_PROGRAM_ID } from "./constants.js";

export interface PerpEligibilityRef {
  readonly listHash: Uint8Array;
  readonly nonce: bigint;
}

export interface RegistryAccountMeta {
  readonly pubkey: PublicKey;
  readonly isSigner: false;
  readonly isWritable: false;
}

/**
 * The registry accounts `validate_basket_items` expects in `remaining_accounts`.
 *
 * Order is not cosmetic. The program reads the token allowlist with `.first()`
 * and the perp eligibility list with `.last()`, and requires the length to be
 * exactly `has_spot + has_perp`, so passing an extra account or reversing the
 * two is rejected rather than ignored.
 *
 * Used by `create_basket`, `publish_composition_draft` and
 * `complete_reconstitution`, which all validate the same composition.
 */
export function registryAccountsForComposition(
  items: readonly { readonly kind: unknown }[],
  options: {
    readonly programId?: PublicKey;
    readonly perpEligibility?: PerpEligibilityRef | undefined;
  } = {},
): RegistryAccountMeta[] {
  const programId = options.programId ?? ALPHABASKET_PROGRAM_ID;
  const has = (item: { readonly kind: unknown }, key: string): boolean =>
    typeof item.kind === "object" && item.kind !== null && key in item.kind;

  const accounts: RegistryAccountMeta[] = [];

  if (items.some((item) => has(item, "spot"))) {
    accounts.push({
      pubkey: deriveTokenAllowlistPda(programId)[0],
      isSigner: false,
      isWritable: false,
    });
  }

  if (items.some((item) => has(item, "perp"))) {
    if (!options.perpEligibility) {
      throw new Error(
        "composition contains a perpetual item but no perp eligibility list was supplied; " +
          "validate_basket_items cannot check the markets without it",
      );
    }
    accounts.push({
      pubkey: derivePerpEligibilityListPda(
        options.perpEligibility.listHash,
        options.perpEligibility.nonce,
        programId,
      )[0],
      isSigner: false,
      isWritable: false,
    });
  }

  return accounts;
}
