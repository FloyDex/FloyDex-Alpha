//! Collateral listing.

use crate::constants::*;
use crate::error::KryonError;
use crate::events::CollateralAdded;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CollateralParams {
    pub haircut_bps: u32,
    /// Required for everything except the settlement asset, which must pass
    /// zeros: it is valued at par.
    pub pyth_feed_id: [u8; 32],
    pub pyth_shard_id: u16,
    pub max_oracle_age_secs: u64,
    pub max_oracle_confidence_bps: u32,
    /// Max net deposits, in token base units.
    pub deposit_cap: u64,
    pub is_settlement: bool,
}

#[derive(Accounts)]
pub struct AddCollateral<'info> {
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump, has_one = admin @ KryonError::Unauthorized)]
    pub exchange: Account<'info, Exchange>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + Collateral::INIT_SPACE,
        seeds = [COLLATERAL_SEED, mint.key().as_ref()],
        bump,
    )]
    pub collateral: Account<'info, Collateral>,
    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = collateral,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Token-2022 extensions a collateral mint may carry. Everything else is
/// refused: transfer fees and hooks break exact vault accounting, permanent
/// delegates and pausable mints let the issuer move or freeze vault funds,
/// and scaled/interest-bearing amounts need valuation support (Phase 2).
const ALLOWED_MINT_EXTENSIONS: &[ExtensionType] = &[
    ExtensionType::MetadataPointer,
    ExtensionType::TokenMetadata,
    ExtensionType::GroupPointer,
    ExtensionType::TokenGroup,
    ExtensionType::GroupMemberPointer,
    ExtensionType::TokenGroupMember,
    ExtensionType::MintCloseAuthority,
];

pub fn check_mint_extensions(mint: &AccountInfo) -> Result<()> {
    if *mint.owner != spl_token_2022::ID {
        return Ok(()); // legacy SPL Token: no extensions
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)
        .map_err(|_| error!(KryonError::UnsupportedMintExtension))?;
    let types = state
        .get_extension_types()
        .map_err(|_| error!(KryonError::UnsupportedMintExtension))?;
    for t in types {
        require!(
            ALLOWED_MINT_EXTENSIONS.contains(&t),
            KryonError::UnsupportedMintExtension
        );
    }
    Ok(())
}

pub fn handle_add_collateral(ctx: Context<AddCollateral>, p: CollateralParams) -> Result<()> {
    let ex = &mut ctx.accounts.exchange;
    let decimals = ctx.accounts.mint.decimals;
    require!(decimals <= MAX_DECIMALS, KryonError::InvalidConfig);
    require!(p.haircut_bps <= 10_000, KryonError::InvalidConfig);
    check_mint_extensions(&ctx.accounts.mint.to_account_info())?;
    if p.is_settlement {
        require!(
            ex.settlement_mint == Pubkey::default(),
            KryonError::SettlementCollateralExists
        );
        require!(
            p.pyth_feed_id == [0; 32] && p.haircut_bps == 0,
            KryonError::InvalidConfig
        );
        ex.settlement_mint = ctx.accounts.mint.key();
        ex.settlement_collateral_index = ex.collateral_count;
    } else {
        require!(
            p.pyth_feed_id != [0; 32]
                && p.max_oracle_age_secs > 0
                && p.max_oracle_confidence_bps <= 10_000,
            KryonError::InvalidConfig
        );
    }
    let index = ex.collateral_count;
    ex.collateral_count = index.checked_add(1).ok_or(KryonError::InvalidConfig)?;

    let c = &mut ctx.accounts.collateral;
    c.mint = ctx.accounts.mint.key();
    c.token_program = ctx.accounts.token_program.key();
    c.vault = ctx.accounts.vault.key();
    c.decimals = decimals;
    c.index = index;
    c.is_settlement = p.is_settlement;
    c.active = true;
    c.haircut_bps = p.haircut_bps;
    c.pyth_feed_id = p.pyth_feed_id;
    c.pyth_shard_id = p.pyth_shard_id;
    c.max_oracle_age_secs = p.max_oracle_age_secs;
    c.max_oracle_confidence_bps = p.max_oracle_confidence_bps;
    c.deposit_cap = p.deposit_cap;
    c.total_deposited = 0;
    c.fees_accrued = 0;
    c.bump = ctx.bumps.collateral;
    c.vault_bump = ctx.bumps.vault;
    emit!(CollateralAdded {
        mint: c.mint,
        index,
        is_settlement: p.is_settlement
    });
    Ok(())
}
