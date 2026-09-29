//! On-chain CLOB: init the book, post a limit, cancel a resting order.

use crate::constants::*;
use crate::error::FloyDexError;
use crate::events::{BookCancelled, BookMatched, BookPosted};
use crate::state::book::{match_against, BookOrder, MarketBook};
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(market_id: u16)]
pub struct InitMarketBook<'info> {
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump, has_one = admin @ FloyDexError::Unauthorized)]
    pub exchange: Account<'info, Exchange>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump = market.load()?.bump,
        constraint = market.load()?.market_id == market_id @ FloyDexError::InvalidConfig,
    )]
    pub market: AccountLoader<'info, Market>,
    #[account(
        init,
        payer = admin,
        space = 8 + core::mem::size_of::<MarketBook>(),
        seeds = [BOOK_SEED, &market_id.to_le_bytes()],
        bump,
    )]
    pub book: AccountLoader<'info, MarketBook>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_market_book(ctx: Context<InitMarketBook>, market_id: u16) -> Result<()> {
    let mut book = ctx.accounts.book.load_init()?;
    book.market_id = market_id;
    book.bump = ctx.bumps.book;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PlaceOrderArgs {
    pub sub_id: u8,
    pub nonce: u64,
    pub price: u64,
    pub size: u64,
    pub expiry_ts: u64,
    pub is_long: bool,
    pub reduce_only: bool,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(args: PlaceOrderArgs)]
pub struct PlaceOrder<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    pub owner: Signer<'info>,
    #[account(
        seeds = [USER_SEED, owner.key().as_ref(), &[args.sub_id]],
        bump = user_account.load()?.bump,
        constraint = user_account.load()?.owner == owner.key() @ FloyDexError::Unauthorized,
    )]
    pub user_account: AccountLoader<'info, UserAccount>,
    #[account(
        seeds = [MARKET_SEED, &market.load()?.market_id.to_le_bytes()],
        bump = market.load()?.bump,
        constraint = market.load()?.active != 0 @ FloyDexError::AssetDisabled,
    )]
    pub market: AccountLoader<'info, Market>,
    #[account(
        mut,
        seeds = [BOOK_SEED, &market.load()?.market_id.to_le_bytes()],
        bump = book.load()?.bump,
    )]
    pub book: AccountLoader<'info, MarketBook>,
}

#[derive(Clone, Copy)]
struct PendingFill {
    maker: Pubkey,
    maker_nonce: u64,
    price: u64,
    size: u64,
}

pub fn handle_place_order(ctx: Context<PlaceOrder>, args: PlaceOrderArgs) -> Result<()> {
    require!(!ctx.accounts.exchange.paused, FloyDexError::Paused);
    require!(args.price > 0, FloyDexError::InvalidPrice);
    require!(args.size > 0, FloyDexError::InvalidAmount);

    let now = Clock::get()?.unix_timestamp as u64;
    require!(
        args.expiry_ts == 0 || args.expiry_ts > now,
        FloyDexError::OrderExpired
    );
    require!(
        args.expiry_ts == 0 || args.expiry_ts <= now.saturating_add(MAX_ORDER_TTL_SECS),
        FloyDexError::InvalidConfig
    );

    let market_id = ctx.accounts.market.load()?.market_id;
    let owner = ctx.accounts.owner.key();
    let mut book = ctx.accounts.book.load_mut()?;
    require!(book.market_id == market_id, FloyDexError::InvalidConfig);
    book.compact_expired(now);

    let mut pending: [PendingFill; BOOK_DEPTH] = [PendingFill {
        maker: Pubkey::default(),
        maker_nonce: 0,
        price: 0,
        size: 0,
    }; BOOK_DEPTH];
    let mut nfill = 0usize;
    let mut remaining = args.size;

    if args.is_long {
        let mut ask_count = book.ask_count;
        let (filled, _) = match_against(
            &mut book.asks,
            &mut ask_count,
            &owner,
            args.price,
            remaining,
            true,
            now,
            |maker, qty| {
                if nfill < BOOK_DEPTH {
                    pending[nfill] = PendingFill {
                        maker: maker.owner,
                        maker_nonce: maker.nonce,
                        price: maker.price,
                        size: qty,
                    };
                    nfill += 1;
                }
            },
        )?;
        book.ask_count = ask_count;
        remaining = remaining.saturating_sub(filled);
    } else {
        let mut bid_count = book.bid_count;
        let (filled, _) = match_against(
            &mut book.bids,
            &mut bid_count,
            &owner,
            args.price,
            remaining,
            false,
            now,
            |maker, qty| {
                if nfill < BOOK_DEPTH {
                    pending[nfill] = PendingFill {
                        maker: maker.owner,
                        maker_nonce: maker.nonce,
                        price: maker.price,
                        size: qty,
                    };
                    nfill += 1;
                }
            },
        )?;
        book.bid_count = bid_count;
        remaining = remaining.saturating_sub(filled);
    }

    if remaining > 0 {
        require!(!args.reduce_only, FloyDexError::ReduceOnlyViolation);
        let resting = BookOrder {
            owner,
            price: args.price,
            size: remaining,
            nonce: args.nonce,
            expiry_ts: args.expiry_ts,
            sub_id: args.sub_id,
            is_long: if args.is_long { 1 } else { 0 },
            _pad: [0; 6],
        };
        if args.is_long {
            book.insert_bid(resting)?;
        } else {
            book.insert_ask(resting)?;
        }
        emit_cpi!(BookPosted {
            market_id,
            owner,
            nonce: args.nonce,
            price: args.price,
            size: remaining,
            is_long: args.is_long,
        });
    }

    book.bump_seq();
    drop(book);

    for fill in pending.iter().take(nfill) {
        emit_cpi!(BookMatched {
            market_id,
            maker: fill.maker,
            taker: owner,
            maker_nonce: fill.maker_nonce,
            taker_nonce: args.nonce,
            price: fill.price,
            size: fill.size,
            taker_is_long: args.is_long,
        });
    }
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(market_id: u16, nonce: u64)]
pub struct CancelBookOrder<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [BOOK_SEED, &market_id.to_le_bytes()],
        bump = book.load()?.bump,
    )]
    pub book: AccountLoader<'info, MarketBook>,
}

pub fn handle_cancel_book_order(
    ctx: Context<CancelBookOrder>,
    market_id: u16,
    nonce: u64,
) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    let mut book = ctx.accounts.book.load_mut()?;
    require!(book.market_id == market_id, FloyDexError::InvalidConfig);
    require!(
        book.remove_owner_nonce(&owner, nonce),
        FloyDexError::BookOrderNotFound
    );
    book.bump_seq();
    emit_cpi!(BookCancelled {
        market_id,
        owner,
        nonce,
    });
    Ok(())
}
