---
name: alphabasket
description: Research, create, and manage weighted Polymarket prediction baskets through AlphaBasket's Solana escrow and MCP tools. Use when users ask to research a thesis, build an AI prediction basket, normalize market weights, create or stake in a basket, inspect positions, prepare claims, claim payouts, or sweep settled surplus.
---

# AlphaBasket

Use AlphaBasket's MCP server to turn a prediction-market thesis into a verified, weighted Polymarket basket and interact with its Solana escrow program.

## Safety

- Never request a seed phrase or a pasted raw private key.
- Use `AI_OPERATOR_KEYPAIR_FILE` only for a dedicated, low-value devnet operator wallet.
- For other users, prepare unsigned stake or claim transactions and let their connected wallet review and sign externally.
- Before any fund-moving or operator-signed action, show the market IDs, outcomes, weights, amount, and network, then obtain explicit confirmation.
- Accept only active Polymarket markets for on-chain basket creation. Verify hydrated market data and normalize weights to exactly 10,000 basis points.
- Treat surplus sweeping as an admin-only operation. Do it only after settlement is final and all positions have claimed.

## Workflow

1. Identify whether the request is research-only, transaction preparation, or an on-chain write.
2. Call `research_thesis` to find and hydrate relevant Polymarket markets.
3. Check market IDs and outcomes, remove unsupported markets, and normalize weights to 10,000 basis points.
4. Present the proposed basket and its assumptions before creating or funding it.
5. For an explicitly approved create action, use `create_basket_onchain` or `research_and_create_basket`.
6. For staking, prefer `prepare_user_stake`. Use `stake_operator_wallet` only when the user explicitly intends to use the configured operator wallet.
7. Inspect state with `get_basket`, `list_baskets`, and `get_wallet_positions`.
8. For claims, prefer `prepare_user_claim`. Use `claim_operator_position` only for the configured operator wallet.
9. Use `sweep_basket_surplus` only with confirmed admin authority and after validating claim completion.

## Operating Notes

- Follow the repository README for MCP startup, environment variables, program deployment, and devnet configuration.
- Keep research and transaction execution distinct. A research result is not permission to create, stake, claim, or sweep.
- Return transaction signatures and explorer links after successful writes. If a write fails, report the exact RPC or program error without retrying a fund-moving action automatically.
