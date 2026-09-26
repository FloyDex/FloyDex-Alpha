//! Collateral listing.

use crate::constants::*;
use crate::error::KryonError;
use crate::events::CollateralAdded;
use crate::state::*;
use crate::token_ext::check_mint_extensions;
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_2022;
use anchor_spl::token_interface::{Mint, TokenInterface};

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
    /// Extra haircut while the underlying's market is closed (`06` §6).
    pub closed_haircut_bps: u32,
    /// Oldest price that may still value it (at the closed haircut); 0 = none.
    pub max_closed_age_secs: u64,
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
    /// Created in the handler, after the extension check: Anchor's `init`
    /// sizes Token-2022 accounts with the pinned spl-token-2022 v6, which
    /// fails on extensions it doesn't know (e.g. the scaled-UI amount).
    /// CHECK: the PDA is checked by seeds; it must not exist yet.
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Create the vault token account at its PDA, owned by the collateral PDA,
/// sized by the token program itself (it knows every extension it runs).
fn create_vault(ctx: &Context<AddCollateral>) -> Result<()> {
    let vault = ctx.accounts.vault.to_account_info();
    require!(vault.lamports() == 0, KryonError::InvalidConfig);
    let token_program = ctx.accounts.token_program.to_account_info();
    let space = token_2022::get_account_data_size(
        CpiContext::new(
            token_program.clone(),
            token_2022::GetAccountDataSize {
                mint: ctx.accounts.mint.to_account_info(),
            },
        ),
        &[],
    )?;
    let mint_key = ctx.accounts.mint.key();
    let seeds: &[&[u8]] = &[VAULT_SEED, mint_key.as_ref(), &[ctx.bumps.vault]];
    system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::CreateAccount {
                from: ctx.accounts.admin.to_account_info(),
                to: vault.clone(),
            },
            &[seeds],
        ),
        Rent::get()?.minimum_balance(space as usize),
        space,
        token_program.key,
    )?;
    token_2022::initialize_account3(CpiContext::new(
        token_program,
        token_2022::InitializeAccount3 {
            account: vault,
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.collateral.to_account_info(),
        },
    ))
}

pub fn handle_add_collateral(ctx: Context<AddCollateral>, p: CollateralParams) -> Result<()> {
    check_mint_extensions(&ctx.accounts.mint.to_account_info())?;
    create_vault(&ctx)?;
    let ex = &mut ctx.accounts.exchange;
    let decimals = ctx.accounts.mint.decimals;
    require!(decimals <= MAX_DECIMALS, KryonError::InvalidConfig);
    require!(p.haircut_bps <= 10_000, KryonError::InvalidConfig);
    if p.is_settlement {
        require!(
            ex.settlement_mint == Pubkey::default(),
            KryonError::SettlementCollateralExists
        );
        require!(
            p.pyth_feed_id == [0; 32]
                && p.haircut_bps == 0
                && p.closed_haircut_bps == 0
                && p.max_closed_age_secs == 0,
            KryonError::InvalidConfig
        );
        ex.settlement_mint = ctx.accounts.mint.key();
        ex.settlement_collateral_index = ex.collateral_count;
    } else {
        require!(
            p.pyth_feed_id != [0; 32]
                && p.max_oracle_age_secs > 0
                && p.max_oracle_confidence_bps <= 10_000
                && p.haircut_bps.saturating_add(p.closed_haircut_bps) <= 10_000
                && (p.max_closed_age_secs == 0 || p.max_closed_age_secs > p.max_oracle_age_secs)
                && p.max_closed_age_secs <= MAX_CLOSED_PRICE_AGE_SECS,
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
    c.closed_haircut_bps = p.closed_haircut_bps;
    c.max_closed_age_secs = p.max_closed_age_secs;
    c.bump = ctx.bumps.collateral;
    c.vault_bump = ctx.bumps.vault;
    emit!(CollateralAdded {
        mint: c.mint,
        index,
        is_settlement: p.is_settlement
    });
    Ok(())
}
