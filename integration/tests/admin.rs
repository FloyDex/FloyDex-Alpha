//! (b) initialize_exchange, two-step admin, roles, pause/unpause,
//! create_market, add_collateral.

use anchor_lang::prelude::Pubkey;
use anchor_spl::token::spl_token;
use anchor_spl::token_2022::spl_token_2022::{self, extension::ExtensionType};
use floydex_integration::*;
use floydex_perps::error::FloyDexError;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn only_the_upgrade_authority_can_initialize() {
    let mut w = World::bare();
    let stranger = funded(&mut w.svm);
    let i = w.init_exchange_ix(&stranger.pubkey());
    assert_err(
        send(&mut w.svm, &[i], &stranger, &[]),
        FloyDexError::NotUpgradeAuthority,
    );

    let i = w.init_exchange_ix(&w.admin.pubkey());
    assert_ok(w.admin_send(&[i]));
    let ex = w.exchange();
    assert_eq!(ex.admin, w.admin.pubkey());
    assert_eq!(ex.guardian, w.guardian.pubkey());
    assert_eq!(ex.domain, DOMAIN);
    assert_eq!(ex.fee_collector, floydex_perps::constants::FEE_COLLECTOR);
    assert!(!ex.paused);

    // A second initialize fails: the PDA already exists.
    let i = w.init_exchange_ix(&w.admin.pubkey());
    assert!(w.admin_send(&[i]).is_err());
}

#[test]
fn admin_handover_is_two_step() {
    let mut w = World::new();
    let next = funded(&mut w.svm);
    let stranger = funded(&mut w.svm);

    // A non-admin cannot nominate.
    let i = ix(
        w.admin_accounts(&stranger.pubkey()),
        ki::NominateAdmin {
            pending_admin: stranger.pubkey(),
        },
    );
    assert_err(
        send(&mut w.svm, &[i], &stranger, &[]),
        FloyDexError::Unauthorized,
    );

    // Accepting with nothing pending fails.
    let accept = |k: &Pubkey| {
        ix(
            ka::AcceptAdmin {
                exchange: exchange_pda(),
                pending_admin: *k,
            },
            ki::AcceptAdmin {},
        )
    };
    assert_err(
        send(&mut w.svm, &[accept(&next.pubkey())], &next, &[]),
        FloyDexError::NotPendingAdmin,
    );

    let i = w.admin_ix(ki::NominateAdmin {
        pending_admin: next.pubkey(),
    });
    assert_ok(w.admin_send(&[i]));
    assert_eq!(
        w.exchange().admin,
        w.admin.pubkey(),
        "nominating does not hand over"
    );

    // Only the nominee can accept.
    assert_err(
        send(&mut w.svm, &[accept(&stranger.pubkey())], &stranger, &[]),
        FloyDexError::NotPendingAdmin,
    );
    assert_ok(send(&mut w.svm, &[accept(&next.pubkey())], &next, &[]));
    let ex = w.exchange();
    assert_eq!(ex.admin, next.pubkey());
    assert_eq!(ex.pending_admin, Pubkey::default());

    // The old admin has lost its powers.
    let i = w.admin_ix(ki::SetGuardian {
        guardian: stranger.pubkey(),
    });
    assert_err(w.admin_send(&[i]), FloyDexError::Unauthorized);
}

#[test]
fn roles_are_admin_only() {
    let mut w = World::new();
    let stranger = funded(&mut w.svm);
    let ops = [stranger.pubkey(); 4];
    let i = ix(
        w.admin_accounts(&stranger.pubkey()),
        ki::SetOperators { operators: ops },
    );
    assert_err(
        send(&mut w.svm, &[i], &stranger, &[]),
        FloyDexError::Unauthorized,
    );
    let i = ix(
        w.admin_accounts(&stranger.pubkey()),
        ki::SetGuardian {
            guardian: stranger.pubkey(),
        },
    );
    assert_err(
        send(&mut w.svm, &[i], &stranger, &[]),
        FloyDexError::Unauthorized,
    );
    let i = ix(
        w.admin_accounts(&stranger.pubkey()),
        ki::SetCalendarAuthority {
            authority: stranger.pubkey(),
        },
    );
    assert_err(
        send(&mut w.svm, &[i], &stranger, &[]),
        FloyDexError::Unauthorized,
    );

    let new_guardian = Keypair::new();
    let mut ops = [Pubkey::default(); 4];
    ops[2] = stranger.pubkey();
    let set = [
        w.admin_ix(ki::SetGuardian {
            guardian: new_guardian.pubkey(),
        }),
        w.admin_ix(ki::SetOperators { operators: ops }),
    ];
    assert_ok(w.admin_send(&set));
    let ex = w.exchange();
    assert_eq!(ex.guardian, new_guardian.pubkey());
    assert!(ex.is_operator(&stranger.pubkey()));
    assert!(!ex.is_operator(&w.operator.pubkey()));
    assert!(
        !ex.is_operator(&Pubkey::default()),
        "an empty slot is never an operator"
    );
}

#[test]
fn fee_config_is_capped() {
    let mut w = World::new();
    let i = w.admin_ix(ki::SetFeeConfig {
        fee_config: floydex_perps::FeeConfig {
            maker_fee_bps: 101,
            taker_fee_bps: 0,
        },
    });
    assert_err(w.admin_send(&[i]), FloyDexError::InvalidConfig);
    let i = w.admin_ix(ki::SetFeeConfig {
        fee_config: floydex_perps::FeeConfig {
            maker_fee_bps: 1,
            taker_fee_bps: 3,
        },
    });
    assert_ok(w.admin_send(&[i]));
    assert_eq!(w.exchange().fee_config.taker_fee_bps, 3);

    let i = w.admin_ix(ki::SetFeeConfig {
        fee_config: floydex_perps::FeeConfig::PLATFORM,
    });
    assert_ok(w.admin_send(&[i]));
    assert_eq!(w.exchange().fee_config.maker_fee_bps, 100);
    assert_eq!(w.exchange().fee_config.taker_fee_bps, 100);
}

#[test]
fn fee_collector_is_settable_and_rejects_default() {
    let mut w = World::new();
    assert_eq!(
        w.exchange().fee_collector,
        floydex_perps::constants::FEE_COLLECTOR
    );
    let i = w.admin_ix(ki::SetFeeCollector {
        collector: Pubkey::default(),
    });
    assert_err(w.admin_send(&[i]), FloyDexError::InvalidConfig);
    let next = funded(&mut w.svm);
    let i = w.admin_ix(ki::SetFeeCollector {
        collector: next.pubkey(),
    });
    assert_ok(w.admin_send(&[i]));
    assert_eq!(w.exchange().fee_collector, next.pubkey());
}

#[test]
fn guardian_pauses_and_only_admin_unpauses() {
    let mut w = World::new();
    let pause = |k: &Pubkey| {
        ix(
            ka::Pause {
                exchange: exchange_pda(),
                guardian: *k,
            },
            ki::Pause {},
        )
    };

    // The admin is not the guardian.
    let i = pause(&w.admin.pubkey());
    assert_err(w.admin_send(&[i]), FloyDexError::Unauthorized);

    let g = w.guardian.insecure_clone();
    assert_ok(send(&mut w.svm, &[pause(&g.pubkey())], &g, &[]));
    assert!(w.exchange().paused);

    // The guardian cannot unpause.
    let i = ix(w.admin_accounts(&g.pubkey()), ki::Unpause {});
    assert_err(send(&mut w.svm, &[i], &g, &[]), FloyDexError::Unauthorized);

    let i = w.admin_ix(ki::Unpause {});
    assert_ok(w.admin_send(&[i]));
    assert!(!w.exchange().paused);
}

#[test]
fn create_market_stores_the_config() {
    let mut w = World::new();
    let i = w.create_market_ix(1, default_market_params());
    assert_ok(w.admin_send(&[i]));
    let m: floydex_perps::state::Market = fetch_zc(&w.svm, &market_pda(1));
    assert_eq!(m.market_id, 1);
    assert_eq!(m.active, 1);
    assert_eq!(m.pyth_feed_id, FEED_TSLA);
    assert_eq!(m.initial_margin_bps, 2_000);
    assert_eq!(m.max_open_interest.get(), 1_000_000 * P);
    assert_eq!(m.session_policy.closed_margin_mult_bps, 20_000);
    assert_eq!(m.funding_max_rate_per_hour.get(), P / 1_000);
    assert_eq!(m.oi_long.get(), 0);

    // Same id twice fails.
    let i = w.create_market_ix(1, default_market_params());
    assert!(w.admin_send(&[i]).is_err());

    // Non-admin cannot create.
    let stranger = funded(&mut w.svm);
    let mut i = w.create_market_ix(2, default_market_params());
    i.accounts[1].pubkey = stranger.pubkey();
    assert_err(
        send(&mut w.svm, &[i], &stranger, &[]),
        FloyDexError::Unauthorized,
    );
}

#[test]
fn create_market_rejects_every_bad_config() {
    let mut w = World::new();
    type Edit = fn(&mut floydex_perps::MarketParams);
    let cases: &[(&str, u16, Edit)] = &[
        ("market id 0", 0, |_| {}),
        ("zero initial margin", 3, |p| p.initial_margin_bps = 0),
        ("maintenance above initial", 3, |p| {
            p.maintenance_margin_bps = p.initial_margin_bps + 1
        }),
        ("leverage looser than margin implies (KRY-Q8)", 3, |p| {
            p.max_leverage_bps = 50_001
        }),
        ("zero leverage", 3, |p| p.max_leverage_bps = 0),
        ("zero max OI", 3, |p| p.max_open_interest = 0),
        ("zero oracle age", 3, |p| p.max_oracle_age_secs = 0),
        ("confidence above 100%", 3, |p| {
            p.max_oracle_confidence_bps = 10_001
        }),
        ("zero deviation band", 3, |p| {
            p.max_execution_deviation_bps = 0
        }),
        ("no feed id", 3, |p| p.pyth_feed_id = [0; 32]),
        ("closed margin below 1x", 3, |p| {
            p.session_policy.closed_margin_mult_bps = 9_999
        }),
        ("extended margin below 1x", 3, |p| {
            p.session_policy.extended_margin_mult_bps = 5_000
        }),
        ("band base above max", 3, |p| {
            p.session_policy.closed_band_base_bps = 2_000
        }),
        ("negative funding coeff", 3, |p| {
            p.funding_imbalance_coeff = -1
        }),
        ("zero funding cap", 3, |p| p.funding_max_rate_per_hour = 0),
        (
            "liquidation fee at maintenance: never liquidatable",
            3,
            |p| p.liquidation_fee_bps = p.maintenance_margin_bps,
        ),
        ("margin ramp over 4 hours", 3, |p| {
            p.session_policy.close_ramp_secs = 4 * 3_600 + 1
        }),
        ("close grace over 4 hours", 3, |p| {
            p.session_policy.close_grace_secs = 4 * 3_600 + 1
        }),
    ];
    for (name, id, edit) in cases {
        let mut p = default_market_params();
        edit(&mut p);
        let i = w.create_market_ix(*id, p);
        let r = w.admin_send(&[i]);
        assert!(r.is_err(), "{name} should be rejected");
        assert_err(r, FloyDexError::InvalidConfig);
    }
}

#[test]
fn aggregate_oi_policy_is_capped_across_markets() {
    // L11: the insurance cap is shared, so the sum over markets is bounded.
    let mut w = World::new(); // max_total_oi_policy_bps = 100_000
    let mut p = default_market_params();
    p.oi_policy_bps = 60_000;
    let i = w.create_market_ix(1, p.clone());
    assert_ok(w.admin_send(&[i]));
    let i = w.create_market_ix(2, p.clone());
    assert_err(w.admin_send(&[i]), FloyDexError::AggregateOiPolicyExceeded);
    p.oi_policy_bps = 40_000;
    let i = w.create_market_ix(2, p);
    assert_ok(w.admin_send(&[i]));
    assert_eq!(w.exchange().total_oi_policy_bps, 100_000);
}

#[test]
fn settlement_collateral_is_unique_and_at_par() {
    let mut w = World::new();
    let admin = w.admin.insecure_clone();
    let usdc = create_mint(&mut w.svm, &admin, spl_token::ID, 6, &[], |_| vec![]);
    let usdc2 = create_mint(&mut w.svm, &admin, spl_token::ID, 6, &[], |_| vec![]);

    // The settlement asset must not carry a feed or a haircut.
    let mut bad = settlement_params();
    bad.pyth_feed_id = FEED_TSLA;
    let i = w.add_collateral_ix(&usdc, spl_token::ID, bad);
    assert_err(w.admin_send(&[i]), FloyDexError::InvalidConfig);

    let i = w.add_collateral_ix(&usdc, spl_token::ID, settlement_params());
    assert_ok(w.admin_send(&[i]));
    let c: floydex_perps::state::Collateral = fetch(&w.svm, &collateral_pda(&usdc));
    assert!(c.is_settlement && c.active);
    assert_eq!((c.decimals, c.index), (6, 0));
    assert_eq!(c.vault, vault_pda(&usdc));
    assert_eq!(c.scale(), 1_000_000_000_000);
    assert_eq!(w.exchange().settlement_mint, usdc);
    assert_eq!(token_balance(&w.svm, &vault_pda(&usdc)), 0);

    let i = w.add_collateral_ix(&usdc2, spl_token::ID, settlement_params());
    assert_err(w.admin_send(&[i]), FloyDexError::SettlementCollateralExists);
}

#[test]
fn non_settlement_collateral_needs_a_feed() {
    let mut w = World::new();
    let admin = w.admin.insecure_clone();
    let x = create_mint(&mut w.svm, &admin, spl_token_2022::ID, 8, &[], |_| vec![]);
    let mut p = settlement_params();
    p.is_settlement = false;
    let i = w.add_collateral_ix(&x, spl_token_2022::ID, p.clone());
    assert_err(w.admin_send(&[i]), FloyDexError::InvalidConfig);
    p.pyth_feed_id = FEED_TSLA;
    p.max_oracle_age_secs = 70;
    p.haircut_bps = 1_500;
    let i = w.add_collateral_ix(&x, spl_token_2022::ID, p);
    assert_ok(w.admin_send(&[i]));
    let c: floydex_perps::state::Collateral = fetch(&w.svm, &collateral_pda(&x));
    assert_eq!(c.token_program, spl_token_2022::ID);
    assert_eq!(c.haircut_bps, 1_500);
}

#[test]
fn token_2022_mints_with_unsupported_extensions_are_refused() {
    let mut w = World::new();
    let admin = w.admin.insecure_clone();
    let admin_key = admin.pubkey();
    let fee_mint = create_mint(
        &mut w.svm,
        &admin,
        spl_token_2022::ID,
        6,
        &[ExtensionType::TransferFeeConfig],
        |m| {
            vec![spl_token_2022::extension::transfer_fee::instruction::initialize_transfer_fee_config(
            &spl_token_2022::ID,
            m,
            Some(&admin_key),
            Some(&admin_key),
            10,
            1_000,
        )
        .unwrap()]
        },
    );
    let mut p = settlement_params();
    p.is_settlement = false;
    p.pyth_feed_id = FEED_TSLA;
    p.max_oracle_age_secs = 70;
    let i = w.add_collateral_ix(&fee_mint, spl_token_2022::ID, p.clone());
    assert_err(w.admin_send(&[i]), FloyDexError::UnsupportedMintExtension);

    let pd_mint = create_mint(
        &mut w.svm,
        &admin,
        spl_token_2022::ID,
        6,
        &[ExtensionType::PermanentDelegate],
        |m| {
            vec![spl_token_2022::instruction::initialize_permanent_delegate(
                &spl_token_2022::ID,
                m,
                &admin_key,
            )
            .unwrap()]
        },
    );
    let i = w.add_collateral_ix(&pd_mint, spl_token_2022::ID, p.clone());
    assert_err(w.admin_send(&[i]), FloyDexError::UnsupportedMintExtension);

    // An allowed extension passes.
    let close_mint = create_mint(
        &mut w.svm,
        &admin,
        spl_token_2022::ID,
        6,
        &[ExtensionType::MintCloseAuthority],
        |m| {
            vec![
                spl_token_2022::instruction::initialize_mint_close_authority(
                    &spl_token_2022::ID,
                    m,
                    Some(&admin_key),
                )
                .unwrap(),
            ]
        },
    );
    let i = w.add_collateral_ix(&close_mint, spl_token_2022::ID, p);
    assert_ok(w.admin_send(&[i]));
}

#[test]
fn mints_above_18_decimals_are_refused() {
    let mut w = World::new();
    let admin = w.admin.insecure_clone();
    let m = create_mint(&mut w.svm, &admin, spl_token::ID, 19, &[], |_| vec![]);
    let i = w.add_collateral_ix(&m, spl_token::ID, settlement_params());
    assert_err(w.admin_send(&[i]), FloyDexError::InvalidConfig);
}
