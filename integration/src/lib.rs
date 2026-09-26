//! Shared LiteSVM harness for the `kryon_perps` program tests.

use anchor_lang::prelude::Pubkey;
#[allow(deprecated)]
use anchor_lang::solana_program::bpf_loader_upgradeable::{self, UpgradeableLoaderState};
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use anchor_spl::token_2022::spl_token_2022;
use kryon_perps::error::KryonError;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::path::PathBuf;

pub use kryon_perps::{accounts as ka, instruction as ki};

pub const P: i128 = protocol_core::PRECISION;
pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn program_so(dir: &str) -> Vec<u8> {
    let so = repo_root().join("target").join(dir).join("kryon_perps.so");
    std::fs::read(&so).unwrap_or_else(|e| panic!("read {}: {e} (build it first)", so.display()))
}

/// A fresh VM with the program loaded from `target/<dir>/kryon_perps.so` as a
/// plain (non-upgradeable) program. Enough for the benchmark.
pub fn svm_with_program(dir: &str) -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(kryon_perps::ID, &program_so(dir)).unwrap();
    svm
}

pub fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(&[kryon_perps::ID.as_ref()], &bpf_loader_upgradeable::ID).0
}

/// Load the program the way `solana program deploy` does: an upgradeable
/// program whose ProgramData names `authority` as upgrade authority.
pub fn load_upgradeable(svm: &mut LiteSVM, authority: &Pubkey) {
    let elf = program_so("deploy");
    let pd = program_data_address();
    let mut data = bincode::serialize(&UpgradeableLoaderState::ProgramData {
        slot: 0,
        upgrade_authority_address: Some(*authority),
    })
    .unwrap();
    data.resize(UpgradeableLoaderState::size_of_programdata_metadata(), 0);
    data.extend_from_slice(&elf);
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        pd,
        Account {
            lamports,
            data,
            owner: bpf_loader_upgradeable::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let data = bincode::serialize(&UpgradeableLoaderState::Program {
        programdata_address: pd,
    })
    .unwrap();
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        kryon_perps::ID,
        Account {
            lamports,
            data,
            owner: bpf_loader_upgradeable::ID,
            executable: true,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

pub fn ix<A: ToAccountMetas, D: InstructionData>(accounts: A, data: D) -> Instruction {
    Instruction {
        program_id: kryon_perps::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

/// Same, with extra (remaining) accounts appended.
pub fn ix_with<A: ToAccountMetas, D: InstructionData>(
    accounts: A,
    data: D,
    extra: Vec<anchor_lang::prelude::AccountMeta>,
) -> Instruction {
    let mut i = ix(accounts, data);
    i.accounts.extend(extra);
    i
}

pub fn compute_budget(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: anchor_lang::solana_program::pubkey!(
            "ComputeBudget111111111111111111111111111111"
        ),
        accounts: vec![],
        data,
    }
}

pub fn send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Keypair,
    signers: &[&Keypair],
) -> TxResult {
    let mut all: Vec<&Keypair> = vec![payer];
    for s in signers {
        if s.pubkey() != payer.pubkey() {
            all.push(s);
        }
    }
    let tx = Transaction::new(
        &all,
        Message::new(ixs, Some(&payer.pubkey())),
        svm.latest_blockhash(),
    );
    let r = svm.send_transaction(tx);
    svm.expire_blockhash();
    r
}

pub fn anchor_code(e: KryonError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

/// Assert a transaction failed with a specific program error.
#[track_caller]
pub fn assert_err(r: TxResult, e: KryonError) {
    let want = anchor_code(e);
    match r {
        Ok(_) => panic!("expected {e:?}, transaction succeeded"),
        Err(f) => {
            let got = format!("{:?}", f.err);
            assert!(
                got.contains(&format!("Custom({want})")),
                "expected {e:?} (Custom({want})), got {got}\nlogs: {:#?}",
                f.meta.logs
            );
        }
    }
}

#[track_caller]
pub fn assert_ok(r: TxResult) -> TransactionMetadata {
    match r {
        Ok(m) => m,
        Err(f) => panic!("transaction failed: {:?}\nlogs: {:#?}", f.err, f.meta.logs),
    }
}

pub fn fetch<T: AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> T {
    let acc = svm
        .get_account(key)
        .unwrap_or_else(|| panic!("missing account {key}"));
    T::try_deserialize(&mut acc.data.as_slice()).unwrap()
}

pub fn fetch_zc<T: bytemuck::Pod>(svm: &LiteSVM, key: &Pubkey) -> T {
    let acc = svm
        .get_account(key)
        .unwrap_or_else(|| panic!("missing account {key}"));
    *bytemuck::from_bytes::<T>(&acc.data[8..8 + core::mem::size_of::<T>()])
}

pub fn funded(svm: &mut LiteSVM) -> Keypair {
    let k = Keypair::new();
    svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    k
}

// --- PDAs ---

pub fn exchange_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"exchange"], &kryon_perps::ID).0
}
pub fn market_pda(id: u16) -> Pubkey {
    Pubkey::find_program_address(&[b"market", &id.to_le_bytes()], &kryon_perps::ID).0
}
pub fn collateral_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"collateral", mint.as_ref()], &kryon_perps::ID).0
}
pub fn vault_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"vault", mint.as_ref()], &kryon_perps::ID).0
}
pub fn user_pda(owner: &Pubkey, sub_id: u8) -> Pubkey {
    Pubkey::find_program_address(&[b"user", owner.as_ref(), &[sub_id]], &kryon_perps::ID).0
}
pub fn order_pda(owner: &Pubkey, sub_id: u8, nonce: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[b"order", owner.as_ref(), &[sub_id], &nonce.to_le_bytes()],
        &kryon_perps::ID,
    )
    .0
}

// --- tokens ---

/// Create a mint owned by `token_program` with the given decimals. For
/// Token-2022, `extensions` are initialized before the mint.
pub fn create_mint(
    svm: &mut LiteSVM,
    payer: &Keypair,
    token_program: Pubkey,
    decimals: u8,
    extensions: &[spl_token_2022::extension::ExtensionType],
    init_ext: impl Fn(&Pubkey) -> Vec<Instruction>,
) -> Pubkey {
    let mint = Keypair::new();
    let space = if token_program == spl_token::ID {
        spl_token::state::Mint::LEN
    } else {
        spl_token_2022::extension::ExtensionType::try_calculate_account_len::<
            spl_token_2022::state::Mint,
        >(extensions)
        .unwrap()
    };
    let lamports = svm.minimum_balance_for_rent_exemption(space);
    let mut ixs = vec![
        anchor_lang::solana_program::system_instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            lamports,
            space as u64,
            &token_program,
        ),
    ];
    ixs.extend(init_ext(&mint.pubkey()));
    ixs.push(
        spl_token_2022::instruction::initialize_mint2(
            &token_program,
            &mint.pubkey(),
            &payer.pubkey(),
            None,
            decimals,
        )
        .unwrap(),
    );
    assert_ok(send(svm, &ixs, payer, &[&mint]));
    mint.pubkey()
}

use anchor_lang::solana_program::program_pack::Pack;

/// Create a token account for `owner` (a fresh keypair account, not an ATA).
pub fn create_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    token_program: Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Pubkey {
    let acct = Keypair::new();
    let space = if token_program == spl_token::ID {
        spl_token::state::Account::LEN
    } else {
        let mint_data = svm.get_account(mint).unwrap().data;
        let m =
            spl_token_2022::extension::StateWithExtensions::<spl_token_2022::state::Mint>::unpack(
                &mint_data,
            )
            .unwrap();
        use spl_token_2022::extension::BaseStateWithExtensions;
        let req = spl_token_2022::extension::ExtensionType::get_required_init_account_extensions(
            &m.get_extension_types().unwrap(),
        );
        spl_token_2022::extension::ExtensionType::try_calculate_account_len::<
            spl_token_2022::state::Account,
        >(&req)
        .unwrap()
    };
    let lamports = svm.minimum_balance_for_rent_exemption(space);
    let ixs = vec![
        anchor_lang::solana_program::system_instruction::create_account(
            &payer.pubkey(),
            &acct.pubkey(),
            lamports,
            space as u64,
            &token_program,
        ),
        spl_token_2022::instruction::initialize_account3(
            &token_program,
            &acct.pubkey(),
            mint,
            owner,
        )
        .unwrap(),
    ];
    assert_ok(send(svm, &ixs, payer, &[&acct]));
    acct.pubkey()
}

pub fn mint_to(
    svm: &mut LiteSVM,
    authority: &Keypair,
    token_program: Pubkey,
    mint: &Pubkey,
    to: &Pubkey,
    amount: u64,
) {
    let i = spl_token_2022::instruction::mint_to(
        &token_program,
        mint,
        to,
        &authority.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    assert_ok(send(svm, &[i], authority, &[]));
}

pub fn token_balance(svm: &LiteSVM, account: &Pubkey) -> u64 {
    let data = svm.get_account(account).unwrap().data;
    // amount sits at the same offset (64) for SPL Token and Token-2022.
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

// --- fixture ---

pub const DOMAIN: [u8; 32] = [7u8; 32];
/// 2026-09-28T13:30:00Z, a Monday regular-session open.
pub const GENESIS_TS: i64 = 1_790_602_200;
pub const FEED_TSLA: [u8; 32] = [0x75; 32];

pub struct World {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub guardian: Keypair,
    pub operator: Keypair,
    pub calendar: Keypair,
}

pub fn default_fees() -> kryon_perps::FeeConfig {
    kryon_perps::FeeConfig {
        maker_fee_bps: 2,
        taker_fee_bps: 5,
    }
}

pub fn default_market_params() -> kryon_perps::MarketParams {
    kryon_perps::MarketParams {
        base_asset: protocol_core::asset_code("TSLA"),
        pyth_feed_id: FEED_TSLA,
        pyth_shard_id: 0,
        max_leverage_bps: 50_000, // 5x, the zero-cost-path cap (06 §8)
        initial_margin_bps: 2_000,
        maintenance_margin_bps: 1_000,
        liquidation_fee_bps: 50,
        max_open_interest: 1_000_000 * P,
        max_oracle_age_secs: 70,
        max_oracle_confidence_bps: 100,
        max_execution_deviation_bps: 100,
        oi_policy_bps: 0,
        session_policy: kryon_perps::SessionPolicyArgs {
            extended_margin_mult_bps: 15_000,
            closed_margin_mult_bps: 20_000,
            closed_band_base_bps: 200,
            closed_band_per_hour_bps: 25,
            closed_band_max_bps: 1_500,
            closed_oi_cap_bps: 5_000,
            close_ramp_secs: 3_600,
            close_grace_secs: 1_800,
        },
        funding_imbalance_coeff: P,
        funding_max_rate_per_hour: P / 1_000,
    }
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

impl World {
    /// VM + program (upgrade authority = admin), exchange not yet initialized.
    pub fn bare() -> Self {
        let mut svm = LiteSVM::new();
        // LiteSVM starts at unix time 0; use a realistic 2026 clock.
        let mut clock = svm.get_sysvar::<anchor_lang::solana_program::clock::Clock>();
        clock.unix_timestamp = GENESIS_TS;
        svm.set_sysvar(&clock);
        let admin = funded(&mut svm);
        load_upgradeable(&mut svm, &admin.pubkey());
        let guardian = funded(&mut svm);
        let operator = funded(&mut svm);
        let calendar = funded(&mut svm);
        World {
            svm,
            admin,
            guardian,
            operator,
            calendar,
        }
    }

    pub fn init_exchange_ix(&self, authority: &Pubkey) -> Instruction {
        ix(
            ka::InitializeExchange {
                exchange: exchange_pda(),
                authority: *authority,
                program: kryon_perps::ID,
                program_data: program_data_address(),
                system_program: anchor_lang::system_program::ID,
            },
            ki::InitializeExchange {
                args: kryon_perps::InitExchangeArgs {
                    domain: DOMAIN,
                    guardian: self.guardian.pubkey(),
                    calendar_authority: self.calendar.pubkey(),
                    fee_config: default_fees(),
                    max_total_oi_policy_bps: 100_000,
                },
            },
        )
    }

    /// Exchange initialized, operator set.
    pub fn new() -> Self {
        let mut w = Self::bare();
        let i = w.init_exchange_ix(&w.admin.pubkey());
        w.admin_send(&[i]).unwrap();
        let mut ops = [Pubkey::default(); 4];
        ops[0] = w.operator.pubkey();
        let i = w.admin_ix(ki::SetOperators { operators: ops });
        w.admin_send(&[i]).unwrap();
        w
    }

    pub fn admin_accounts(&self, admin: &Pubkey) -> ka::AdminOnly {
        ka::AdminOnly {
            exchange: exchange_pda(),
            admin: *admin,
        }
    }

    pub fn admin_ix<D: InstructionData>(&self, data: D) -> Instruction {
        ix(self.admin_accounts(&self.admin.pubkey()), data)
    }

    pub fn admin_send(&mut self, ixs: &[Instruction]) -> TxResult {
        let admin = self.admin.insecure_clone();
        send(&mut self.svm, ixs, &admin, &[])
    }

    pub fn create_market_ix(
        &self,
        market_id: u16,
        params: kryon_perps::MarketParams,
    ) -> Instruction {
        ix(
            ka::CreateMarket {
                exchange: exchange_pda(),
                admin: self.admin.pubkey(),
                market: market_pda(market_id),
                system_program: anchor_lang::system_program::ID,
            },
            ki::CreateMarket { market_id, params },
        )
    }

    pub fn add_collateral_ix(
        &self,
        mint: &Pubkey,
        token_program: Pubkey,
        params: kryon_perps::CollateralParams,
    ) -> Instruction {
        ix(
            ka::AddCollateral {
                exchange: exchange_pda(),
                admin: self.admin.pubkey(),
                mint: *mint,
                collateral: collateral_pda(mint),
                vault: vault_pda(mint),
                token_program,
                system_program: anchor_lang::system_program::ID,
            },
            ki::AddCollateral { params },
        )
    }

    pub fn exchange(&self) -> kryon_perps::state::Exchange {
        fetch(&self.svm, &exchange_pda())
    }

    pub fn now(&self) -> i64 {
        self.svm
            .get_sysvar::<anchor_lang::solana_program::clock::Clock>()
            .unix_timestamp
    }

    pub fn warp_to(&mut self, unix_timestamp: i64) {
        let mut c = self
            .svm
            .get_sysvar::<anchor_lang::solana_program::clock::Clock>();
        c.unix_timestamp = unix_timestamp;
        c.slot += 1;
        self.svm.set_sysvar(&c);
    }
}

pub fn settlement_params() -> kryon_perps::CollateralParams {
    kryon_perps::CollateralParams {
        haircut_bps: 0,
        pyth_feed_id: [0; 32],
        pyth_shard_id: 0,
        max_oracle_age_secs: 0,
        max_oracle_confidence_bps: 0,
        deposit_cap: u64::MAX,
        is_settlement: true,
    }
}

// --- mocked Pyth ---

/// Write a fully verified `PriceUpdateV2` at the push-feed address for
/// `(shard, feed)`, owned by the Pyth receiver program: exactly what the
/// program reads on mainnet, minus the Wormhole posting.
pub fn mock_price(
    svm: &mut LiteSVM,
    shard: u16,
    feed: [u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
) -> Pubkey {
    use anchor_lang::AccountSerialize;
    use pyth_solana_receiver_sdk::price_update::{
        PriceFeedMessage, PriceUpdateV2, VerificationLevel,
    };
    mock_price_with(
        svm,
        kryon_perps::oracle::push_feed_address(shard, &feed),
        pyth_solana_receiver_sdk::ID,
        {
            let u = PriceUpdateV2 {
                write_authority: Pubkey::default(),
                verification_level: VerificationLevel::Full,
                price_message: PriceFeedMessage {
                    feed_id: feed,
                    price,
                    conf,
                    exponent: expo,
                    publish_time,
                    prev_publish_time: publish_time - 1,
                    ema_price: price,
                    ema_conf: conf,
                },
                posted_slot: 0,
            };
            let mut data = Vec::new();
            u.try_serialize(&mut data).unwrap();
            data
        },
    )
}

pub fn mock_price_with(svm: &mut LiteSVM, address: Pubkey, owner: Pubkey, data: Vec<u8>) -> Pubkey {
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        address,
        Account {
            lamports,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    address
}

/// USD price in whole dollars at expo -8, 0.01% confidence.
pub fn mock_usd(svm: &mut LiteSVM, feed: [u8; 32], dollars: f64, publish_time: i64) -> Pubkey {
    let price = (dollars * 1e8).round() as i64;
    mock_price(
        svm,
        0,
        feed,
        price,
        (price / 10_000) as u64,
        -8,
        publish_time,
    )
}

/// Edit a zero-copy account in place (test-only state surgery).
pub fn patch_zc<T: bytemuck::Pod>(svm: &mut LiteSVM, key: &Pubkey, f: impl FnOnce(&mut T)) {
    let mut acc = svm.get_account(key).unwrap();
    f(bytemuck::from_bytes_mut::<T>(
        &mut acc.data[8..8 + core::mem::size_of::<T>()],
    ));
    svm.set_account(*key, acc).unwrap();
}

pub fn event_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &kryon_perps::ID).0
}

pub fn meta(key: Pubkey, writable: bool) -> anchor_lang::prelude::AccountMeta {
    if writable {
        anchor_lang::prelude::AccountMeta::new(key, false)
    } else {
        anchor_lang::prelude::AccountMeta::new_readonly(key, false)
    }
}

// --- traders ---

pub struct Asset {
    pub mint: Pubkey,
    pub token_program: Pubkey,
}

pub struct Trader {
    pub kp: Keypair,
    pub sub_id: u8,
    pub user: Pubkey,
}

impl Trader {
    pub fn key(&self) -> Pubkey {
        self.kp.pubkey()
    }
}

impl World {
    /// Settlement USDC (6 decimals, legacy SPL Token) with the given cap.
    pub fn add_usdc(&mut self, cap: u64) -> Asset {
        let admin = self.admin.insecure_clone();
        let mint = create_mint(&mut self.svm, &admin, spl_token::ID, 6, &[], |_| vec![]);
        let mut p = settlement_params();
        p.deposit_cap = cap;
        let i = self.add_collateral_ix(&mint, spl_token::ID, p);
        assert_ok(self.admin_send(&[i]));
        Asset {
            mint,
            token_program: spl_token::ID,
        }
    }

    /// A Token-2022 xStock-like collateral (8 decimals) priced by `feed`.
    pub fn add_xstock(&mut self, feed: [u8; 32], haircut_bps: u32) -> Asset {
        let admin = self.admin.insecure_clone();
        let mint = create_mint(
            &mut self.svm,
            &admin,
            spl_token_2022::ID,
            8,
            &[],
            |_| vec![],
        );
        let p = kryon_perps::CollateralParams {
            haircut_bps,
            pyth_feed_id: feed,
            pyth_shard_id: 0,
            max_oracle_age_secs: 70,
            max_oracle_confidence_bps: 100,
            deposit_cap: u64::MAX,
            is_settlement: false,
        };
        let i = self.add_collateral_ix(&mint, spl_token_2022::ID, p);
        assert_ok(self.admin_send(&[i]));
        Asset {
            mint,
            token_program: spl_token_2022::ID,
        }
    }

    pub fn trader(&mut self, sub_id: u8) -> Trader {
        let kp = funded(&mut self.svm);
        let user = user_pda(&kp.pubkey(), sub_id);
        let i = ix(
            ka::InitUser {
                owner: kp.pubkey(),
                user_account: user,
                system_program: anchor_lang::system_program::ID,
            },
            ki::InitUser { sub_id },
        );
        assert_ok(send(&mut self.svm, &[i], &kp, &[]));
        Trader { kp, sub_id, user }
    }

    /// The trader's token account for `asset`, created and funded on first use.
    pub fn wallet(&mut self, t: &Trader, asset: &Asset, mint_amount: u64) -> Pubkey {
        let admin = self.admin.insecure_clone();
        let acct = create_token_account(
            &mut self.svm,
            &admin,
            asset.token_program,
            &asset.mint,
            &t.key(),
        );
        if mint_amount > 0 {
            mint_to(
                &mut self.svm,
                &admin,
                asset.token_program,
                &asset.mint,
                &acct,
                mint_amount,
            );
        }
        acct
    }

    pub fn move_accounts(
        &self,
        owner: &Pubkey,
        user: &Pubkey,
        asset: &Asset,
        user_token: &Pubkey,
    ) -> ka::MoveCollateral {
        ka::MoveCollateral {
            exchange: exchange_pda(),
            owner: *owner,
            user_account: *user,
            collateral: collateral_pda(&asset.mint),
            mint: asset.mint,
            vault: vault_pda(&asset.mint),
            user_token: *user_token,
            token_program: asset.token_program,
            event_authority: event_authority(),
            program: kryon_perps::ID,
        }
    }

    pub fn deposit(&mut self, t: &Trader, asset: &Asset, from: &Pubkey, amount: u64) -> TxResult {
        let i = ix(
            self.move_accounts(&t.key(), &t.user, asset, from),
            ki::Deposit { amount },
        );
        send(&mut self.svm, &[i], &t.kp, &[])
    }

    pub fn withdraw(
        &mut self,
        t: &Trader,
        asset: &Asset,
        to: &Pubkey,
        amount: u64,
        extra: Vec<anchor_lang::prelude::AccountMeta>,
    ) -> TxResult {
        let i = ix_with(
            self.move_accounts(&t.key(), &t.user, asset, to),
            ki::Withdraw { amount },
            extra,
        );
        send(&mut self.svm, &[compute_budget(1_400_000), i], &t.kp, &[])
    }

    pub fn user(&self, t: &Trader) -> kryon_perps::state::UserAccount {
        fetch_zc(&self.svm, &t.user)
    }

    pub fn collateral(&self, asset: &Asset) -> kryon_perps::state::Collateral {
        fetch(&self.svm, &collateral_pda(&asset.mint))
    }

    pub fn market(&self, id: u16) -> kryon_perps::state::Market {
        fetch_zc(&self.svm, &market_pda(id))
    }

    /// Market with a Regular window around now and a fresh oracle.
    pub fn open_market(&mut self, id: u16, dollars: f64) -> Pubkey {
        let i = self.create_market_ix(id, default_market_params());
        assert_ok(self.admin_send(&[i]));
        let now = self.now();
        self.post_regular_window(id, now - 3_600, now + 7 * 86_400);
        mock_usd(
            &mut self.svm,
            default_market_params().pyth_feed_id,
            dollars,
            now,
        )
    }

    /// Write a Regular window directly into the market (until
    /// `post_session_calendar` lands, and for surgical tests after).
    pub fn post_regular_window(&mut self, id: u16, start: i64, end: i64) {
        patch_zc::<kryon_perps::state::Market>(&mut self.svm, &market_pda(id), |m| {
            m.calendar[0] = kryon_perps::state::SessionWindowPod {
                start: start as u64,
                end: end as u64,
                session: kryon_perps::state::SESSION_REGULAR,
                _pad: [0; 7],
            };
        });
    }
}

/// Put an open position straight into a user account (test-only), for
/// exercising health before `settle_fills` exists.
pub fn inject_position(
    svm: &mut LiteSVM,
    user: &Pubkey,
    market_id: u16,
    is_long: bool,
    size: i128,
    entry: i128,
) {
    patch_zc::<kryon_perps::state::UserAccount>(svm, user, |u| {
        let i = u.positions.iter().position(|p| p.in_use == 0).unwrap();
        u.positions[i] = kryon_perps::state::PositionSlot {
            position_id: u.next_position_id,
            size: size.into(),
            entry_price: entry.into(),
            last_funding_index: 0.into(),
            market_id,
            is_long: is_long as u8,
            in_use: 1,
            _pad: [0; 4],
        };
        u.next_position_id += 1;
        u.open_positions += 1;
    });
}

impl World {
    pub fn set_delegate(&mut self, t: &Trader, delegate: &Pubkey, expiry: i64) -> TxResult {
        let i = ix(
            ka::OwnerOnly {
                owner: t.key(),
                user_account: t.user,
                event_authority: event_authority(),
                program: kryon_perps::ID,
            },
            ki::SetDelegate {
                delegate: *delegate,
                expiry,
            },
        );
        send(&mut self.svm, &[i], &t.kp, &[])
    }

    pub fn revoke_delegate(&mut self, t: &Trader) -> TxResult {
        let i = ix(
            ka::OwnerOnly {
                owner: t.key(),
                user_account: t.user,
                event_authority: event_authority(),
                program: kryon_perps::ID,
            },
            ki::RevokeDelegate {},
        );
        send(&mut self.svm, &[i], &t.kp, &[])
    }
}

// --- orders, Ed25519, settle ---

pub use kryon_perps::ed25519::SigRef;
pub use kryon_perps::{FillArgs, OrderArgs};

pub const ED25519_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111");

pub fn order_args(
    market_id: u16,
    is_long: bool,
    size: u64,
    limit_price: u64,
    nonce: u64,
    expiry_ts: u64,
) -> OrderArgs {
    OrderArgs {
        market_id,
        flags: if is_long {
            protocol_core::FLAG_IS_LONG
        } else {
            0
        },
        size,
        limit_price,
        nonce,
        expiry_ts,
    }
}

/// The 108 bytes a key signs for `o`, as trader `t` (owner + sub-account).
pub fn order_message(domain: [u8; 32], t: &Trader, o: &OrderArgs) -> Vec<u8> {
    protocol_core::OrderMsg {
        domain,
        owner: t.key().to_bytes(),
        sub_id: t.sub_id,
        market_id: o.market_id,
        flags: o.flags,
        size: o.size,
        limit_price: o.limit_price,
        nonce: o.nonce,
        expiry_ts: o.expiry_ts,
    }
    .encode()
    .to_vec()
}

/// One entry of an Ed25519 instruction, before layout.
#[derive(Clone)]
pub struct SigEntry {
    pub pubkey: [u8; 32],
    pub signature: [u8; 64],
    pub message: Vec<u8>,
    /// Instruction indexes to write into the offsets (u16::MAX = this one).
    pub sig_ix: u16,
    pub pk_ix: u16,
    pub msg_ix: u16,
}

impl SigEntry {
    pub fn sign(signer: &Keypair, message: &[u8]) -> Self {
        let signature: [u8; 64] = signer.sign_message(message).into();
        SigEntry {
            pubkey: signer.pubkey().to_bytes(),
            signature,
            message: message.to_vec(),
            sig_ix: u16::MAX,
            pk_ix: u16::MAX,
            msg_ix: u16::MAX,
        }
    }
}

/// Lay out an Ed25519 program instruction the way `@solana/web3.js` does:
/// `[count, pad, offsets…]` then, per signature, pubkey ‖ signature ‖ message.
pub fn ed25519_ix(entries: &[SigEntry]) -> Instruction {
    let header = 2 + 14 * entries.len();
    let mut body = Vec::new();
    let mut offsets = Vec::new();
    for e in entries {
        let pk = (header + body.len()) as u16;
        body.extend_from_slice(&e.pubkey);
        let sig = (header + body.len()) as u16;
        body.extend_from_slice(&e.signature);
        let msg = (header + body.len()) as u16;
        body.extend_from_slice(&e.message);
        for v in [
            sig,
            e.sig_ix,
            pk,
            e.pk_ix,
            msg,
            e.message.len() as u16,
            e.msg_ix,
        ] {
            offsets.extend_from_slice(&v.to_le_bytes());
        }
    }
    let mut data = vec![entries.len() as u8, 0];
    data.extend(offsets);
    data.extend(body);
    Instruction {
        program_id: ED25519_ID,
        accounts: vec![],
        data,
    }
}

/// Everything one fill needs besides the signatures.
#[derive(Clone)]
pub struct FillPlan<'a> {
    pub maker: &'a Trader,
    pub taker: &'a Trader,
    pub maker_order: OrderArgs,
    pub taker_order: OrderArgs,
    pub size: u64,
    pub price: u64,
    /// Remaining accounts for each side's other markets / collateral.
    pub maker_risk: Vec<anchor_lang::prelude::AccountMeta>,
    pub taker_risk: Vec<anchor_lang::prelude::AccountMeta>,
}

impl World {
    pub fn settle_accounts(&self, market_id: u16, operator: &Pubkey) -> ka::SettleFills {
        let m = self.market(market_id);
        ka::SettleFills {
            exchange: exchange_pda(),
            operator: *operator,
            market: market_pda(market_id),
            price_update: kryon_perps::oracle::push_feed_address(m.pyth_shard_id, &m.pyth_feed_id),
            settlement_collateral: collateral_pda(&self.exchange().settlement_mint),
            instructions: anchor_lang::solana_program::sysvar::instructions::ID,
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: kryon_perps::ID,
        }
    }

    /// `settle_fills` for `plans`, referencing signatures in instruction 1
    /// (instruction 0 is the compute budget): fill k uses signatures 2k
    /// (maker) and 2k+1 (taker).
    pub fn settle_ix(&self, market_id: u16, plans: &[FillPlan]) -> Instruction {
        let mut fills = Vec::new();
        let mut extra = Vec::new();
        for (k, p) in plans.iter().enumerate() {
            fills.push(FillArgs {
                maker: p.maker_order,
                taker: p.taker_order,
                fill_size: p.size,
                fill_price: p.price,
                maker_sig: SigRef {
                    ix_index: 1,
                    sig_index: (2 * k) as u8,
                },
                taker_sig: SigRef {
                    ix_index: 1,
                    sig_index: (2 * k + 1) as u8,
                },
            });
            extra.push(meta(p.maker.user, true));
            extra.push(meta(p.taker.user, true));
            extra.push(meta(
                order_pda(&p.maker.key(), p.maker.sub_id, p.maker_order.nonce),
                true,
            ));
            extra.push(meta(
                order_pda(&p.taker.key(), p.taker.sub_id, p.taker_order.nonce),
                true,
            ));
            extra.extend(p.maker_risk.iter().cloned());
            extra.extend(p.taker_risk.iter().cloned());
        }
        ix_with(
            self.settle_accounts(market_id, &self.operator.pubkey()),
            ki::SettleFills { fills },
            extra,
        )
    }

    /// Sign each order with the given key and settle, as the operator.
    pub fn settle(
        &mut self,
        market_id: u16,
        plans: &[FillPlan],
        signers: &[(&Keypair, &Keypair)],
    ) -> TxResult {
        let mut entries = Vec::new();
        for (p, (ms, ts)) in plans.iter().zip(signers) {
            entries.push(SigEntry::sign(
                ms,
                &order_message(DOMAIN, p.maker, &p.maker_order),
            ));
            entries.push(SigEntry::sign(
                ts,
                &order_message(DOMAIN, p.taker, &p.taker_order),
            ));
        }
        self.settle_with(market_id, plans, ed25519_ix(&entries))
    }

    pub fn settle_with(&mut self, market_id: u16, plans: &[FillPlan], ed: Instruction) -> TxResult {
        let settle = self.settle_ix(market_id, plans);
        let op = self.operator.insecure_clone();
        send(
            &mut self.svm,
            &[compute_budget(1_400_000), ed, settle],
            &op,
            &[],
        )
    }
}

// --- conservation (05 §7.1, decided 2026-09-26) ---

/// Liabilities in the settlement asset, PRECISION-scaled: user balances +
/// fees + what every open position would realize if closed at `price`
/// (rounded toward −∞, exactly as the program would pay it), plus pending
/// funding. Only market `market_id` is considered.
pub fn settlement_liabilities(w: &World, users: &[&Trader], market_id: u16, price: i128) -> i128 {
    let ex = w.exchange();
    let c: kryon_perps::state::Collateral = fetch(&w.svm, &collateral_pda(&ex.settlement_mint));
    let m = w.market(market_id);
    let mut total = c.fees_accrued;
    for t in users {
        let u = w.user(t);
        total += u.balance(ex.settlement_collateral_index);
        for p in u
            .positions
            .iter()
            .filter(|p| p.in_use != 0 && p.market_id == market_id)
        {
            let size = p.size.get();
            let per_unit = if p.is_long != 0 {
                price - p.entry_price.get()
            } else {
                p.entry_price.get() - price
            };
            total += protocol_core::mul_div_floor(size, per_unit, P).unwrap();
            let index = m.funding_index(p.is_long != 0);
            total +=
                protocol_core::mul_div_floor(-size, index - p.last_funding_index.get(), P).unwrap();
        }
    }
    total
}

/// Solvency: the vault covers every liability; any dust is the protocol's.
#[track_caller]
pub fn assert_solvent(
    w: &World,
    usdc: &Asset,
    users: &[&Trader],
    market_id: u16,
    price: i128,
) -> i128 {
    let c = w.collateral(usdc);
    let vault = i128::from(token_balance(&w.svm, &vault_pda(&usdc.mint))) * c.scale();
    let liabilities = settlement_liabilities(w, users, market_id, price);
    let slack = vault - liabilities;
    assert!(slack >= 0, "insolvent by {} wei at price {price}", -slack);
    slack
}

/// Strict when flat: with no open positions, the vault equals balances +
/// fees in token base units (the sub-unit remainder is protocol dust).
#[track_caller]
pub fn assert_conserved_flat(w: &World, usdc: &Asset, users: &[&Trader]) {
    for t in users {
        assert!(
            w.user(t).positions.iter().all(|p| p.in_use == 0),
            "not flat"
        );
    }
    let c = w.collateral(usdc);
    let vault = i128::from(token_balance(&w.svm, &vault_pda(&usdc.mint))) * c.scale();
    let sum: i128 = users
        .iter()
        .map(|t| w.user(t).balance(c.index))
        .sum::<i128>()
        + c.fees_accrued;
    let dust = vault - sum;
    assert!(
        (0..c.scale()).contains(&dust),
        "vault {vault} vs balances+fees {sum}: dust {dust}"
    );
}

impl World {
    pub fn post_calendar(
        &mut self,
        market_id: u16,
        windows: Vec<kryon_perps::SessionWindowArgs>,
    ) -> TxResult {
        let c = self.calendar.insecure_clone();
        let i = ix(
            ka::PostSessionCalendar {
                exchange: exchange_pda(),
                calendar_authority: c.pubkey(),
                market: market_pda(market_id),
            },
            ki::PostSessionCalendar { windows },
        );
        send(&mut self.svm, &[i], &c, &[])
    }
}

pub fn window(start: i64, end: i64, session: u8) -> kryon_perps::SessionWindowArgs {
    kryon_perps::SessionWindowArgs {
        start: start as u64,
        end: end as u64,
        session,
    }
}

impl World {
    pub fn post_mark_as(&mut self, market_id: u16, mid: u64, operator: &Keypair) -> TxResult {
        let m = self.market(market_id);
        let i = ix(
            ka::PostMark {
                exchange: exchange_pda(),
                operator: operator.pubkey(),
                market: market_pda(market_id),
                price_update: kryon_perps::oracle::push_feed_address(
                    m.pyth_shard_id,
                    &m.pyth_feed_id,
                ),
                event_authority: event_authority(),
                program: kryon_perps::ID,
            },
            ki::PostMark { mid },
        );
        send(&mut self.svm, &[i], operator, &[])
    }

    /// `post_mark` as the operator. `mid` is u64 at 1e9.
    pub fn post_mark(&mut self, market_id: u16, mid: u64) -> TxResult {
        let op = self.operator.insecure_clone();
        self.post_mark_as(market_id, mid, &op)
    }

    /// Advance the clock by `secs`.
    pub fn warp(&mut self, secs: i64) {
        let t = self.now() + secs;
        self.warp_to(t);
    }

    /// Drop every posted window: the market resolves to Closed.
    pub fn close_market(&mut self, market_id: u16) {
        patch_zc::<kryon_perps::state::Market>(&mut self.svm, &market_pda(market_id), |m| {
            m.calendar = Default::default()
        });
    }
}

impl World {
    /// `update_funding` paid for by `payer` (permissionless).
    pub fn update_funding_as(&mut self, market_id: u16, payer: &Keypair) -> TxResult {
        let m = self.market(market_id);
        let i = ix(
            ka::UpdateFunding {
                exchange: exchange_pda(),
                market: market_pda(market_id),
                price_update: kryon_perps::oracle::push_feed_address(
                    m.pyth_shard_id,
                    &m.pyth_feed_id,
                ),
                event_authority: event_authority(),
                program: kryon_perps::ID,
            },
            ki::UpdateFunding {},
        );
        send(&mut self.svm, &[i], payer, &[])
    }

    pub fn update_funding(&mut self, market_id: u16) -> TxResult {
        let k = funded(&mut self.svm);
        self.update_funding_as(market_id, &k)
    }

    /// Advance the clock and re-publish the market's oracle at `dollars`.
    pub fn tick(&mut self, secs: i64, dollars: f64) {
        self.warp(secs);
        let now = self.now();
        mock_usd(&mut self.svm, FEED_TSLA, dollars, now);
    }
}
