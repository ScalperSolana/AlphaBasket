//! AlphaBasket v2 internal-share accounting program.
use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

pub use constants::*;
pub use errors::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm");

#[program]
pub mod polybaskets_escrow {
    use super::*;

    /// Initializes the singleton configuration under the program upgrade authority.
    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        instructions::initialize::initialize_handler(ctx, args)
    }

    /// Rotates operational signer and treasury authorities.
    pub fn set_authorities(
        ctx: Context<AdminOnly>,
        new_composer_signer: Option<Pubkey>,
        new_backend_signer: Option<Pubkey>,
        new_protocol_treasury: Option<Pubkey>,
    ) -> Result<()> {
        instructions::admin::set_authorities_handler(
            ctx,
            new_composer_signer,
            new_backend_signer,
            new_protocol_treasury,
        )
    }

    /// Starts the two-step administrator transfer.
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::propose_admin_handler(ctx, new_admin)
    }

    /// Accepts administrator authority as the proposed key.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::accept_admin_handler(ctx)
    }

    /// Cancels a pending administrator transfer.
    pub fn cancel_admin_transfer(ctx: Context<AdminOnly>) -> Result<()> {
        instructions::admin::cancel_admin_transfer_handler(ctx)
    }

    /// Updates the global user slippage bound.
    pub fn set_limits(ctx: Context<AdminOnly>, max_slippage_bps: u16) -> Result<()> {
        instructions::admin::set_limits_handler(ctx, max_slippage_bps)
    }

    /// Pauses or resumes user and execution completion flows.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        instructions::admin::set_paused_handler(ctx, paused)
    }

    /// Only the configured Composer Service key can create a basket.
    pub fn create_basket(ctx: Context<CreateBasket>, args: CreateBasketArgs) -> Result<()> {
        instructions::create_basket::create_basket_handler(ctx, args)
    }

    /// Publishes a short-lived Composer-screened prediction-market list.
    pub fn publish_eligibility_list(
        ctx: Context<PublishEligibilityList>,
        args: PublishEligibilityListArgs,
    ) -> Result<()> {
        instructions::registry::publish_eligibility_list_handler(ctx, args)
    }

    /// Publishes the Composer-screened Phoenix perpetual market list.
    pub fn publish_perp_eligibility_list(
        ctx: Context<PublishPerpEligibilityList>,
        args: PublishPerpEligibilityListArgs,
    ) -> Result<()> {
        instructions::registry::publish_perp_eligibility_list_handler(ctx, args)
    }

    /// Publishes a creator-selected weighted composition in a size-safe prior transaction.
    pub fn publish_composition_draft(
        ctx: Context<PublishCompositionDraft>,
        args: PublishCompositionDraftArgs,
    ) -> Result<()> {
        instructions::registry::publish_composition_draft_handler(ctx, args)
    }

    /// Adds, updates, disables, or re-enables a Jupiter spot-token allowlist entry.
    pub fn register_token(ctx: Context<RegisterToken>, args: RegisterTokenArgs) -> Result<()> {
        instructions::registry::register_token_handler(ctx, args)
    }

    /// Records a fresh Composer-signed TWAP for a signed-fallback spot token.
    pub fn submit_price_attestation(
        ctx: Context<SubmitPriceAttestation>,
        args: SubmitPriceAttestationArgs,
    ) -> Result<()> {
        instructions::registry::submit_price_attestation_handler(ctx, args)
    }

    /// Completes a user-signed deposit after external Polymarket execution.
    pub fn complete_deposit(
        ctx: Context<CompleteDeposit>,
        args: CompleteDepositArgs,
    ) -> Result<()> {
        instructions::settlement::complete_deposit_handler(ctx, args)
    }

    /// Permissionless crank; dilution is proportional to exact elapsed seconds.
    pub fn accrue_management_fee(ctx: Context<AccrueManagementFee>) -> Result<()> {
        instructions::settlement::accrue_management_fee_handler(ctx)
    }

    /// Completes both an active early exit and a final redemption.
    pub fn complete_withdrawal(
        ctx: Context<CompleteWithdrawal>,
        args: CompleteWithdrawalArgs,
    ) -> Result<()> {
        instructions::settlement::complete_withdrawal_handler(ctx, args)
    }

    /// Redeems accrued protocol dilution shares after external execution.
    pub fn complete_protocol_fee_withdrawal(
        ctx: Context<CompleteProtocolFeeWithdrawal>,
        args: CompleteProtocolFeeWithdrawalArgs,
    ) -> Result<()> {
        instructions::settlement::complete_protocol_fee_withdrawal_handler(ctx, args)
    }

    /// Moves an eligible perpetual basket into reconstitution.
    pub fn begin_reconstitution(ctx: Context<BackendBasketAction>) -> Result<()> {
        instructions::settlement::begin_reconstitution_handler(ctx)
    }

    /// Applies a new Composer-signed canonical composition.
    pub fn complete_reconstitution(
        ctx: Context<CompleteReconstitution>,
        args: ReconstitutionArgs,
    ) -> Result<()> {
        instructions::settlement::complete_reconstitution_handler(ctx, args)
    }

    /// Stops deposits and starts resolution for a non-perpetual basket.
    pub fn begin_resolution(ctx: Context<BackendBasketAction>) -> Result<()> {
        instructions::settlement::begin_resolution_handler(ctx)
    }

    // --- Phoenix perpetuals ------------------------------------------------
    //
    // Recording only. Phoenix trading happens off chain through the Rise SDK;
    // this program never CPIs into Phoenix. See `instructions/phoenix.rs`.

    /// One-time registration of a Phoenix trader account for an execution wallet.
    pub fn onboard_trader_account(
        ctx: Context<OnboardTraderAccount>,
        args: OnboardTraderAccountArgs,
    ) -> Result<()> {
        instructions::phoenix::onboard_trader_account_handler(ctx, args)
    }

    /// Records an already-executed, vault-delta-verified Phoenix trade and
    /// updates the composition item it belongs to.
    pub fn complete_phoenix_trade(
        ctx: Context<CompletePhoenixTrade>,
        args: CompletePhoenixTradeArgs,
    ) -> Result<()> {
        instructions::phoenix::complete_phoenix_trade_handler(ctx, args)
    }

    /// Records an autonomous Phoenix event. Callable unprompted, with no prior
    /// AlphaBasket-initiated request and no matching trade receipt.
    pub fn attest_perp_event(
        ctx: Context<AttestPerpEvent>,
        args: AttestPerpEventArgs,
    ) -> Result<()> {
        instructions::phoenix::attest_perp_event_handler(ctx, args)
    }

    /// Records the final NAV and share snapshot for deterministic redemptions.
    pub fn record_final_settlement(
        ctx: Context<BackendBasketAction>,
        args: FinalSettlementArgs,
    ) -> Result<()> {
        instructions::settlement::record_final_settlement_handler(ctx, args)
    }
}
