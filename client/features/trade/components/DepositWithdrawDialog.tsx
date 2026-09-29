"use client";

import { useState, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletStore } from "@/stores/wallet";
import { deposit, withdraw } from "@/lib/solana/funds";
import {
  listVaultCollateral,
  getBalance,
  getTokenBalance,
  hasTrustline,
  addTrustline,
  roundToBridgeable,
} from "@/lib/solana/vault";
import { getAccountHealth, getVenueSnapshot } from "@/lib/solana/account";
import type { ListedCollateral } from "@/lib/stellar/collateral";
import { humanToAmount, amountToHuman, formatAccountUsd } from "@/lib/format";
import { SETTLEMENT_ASSET, STELLAR_EXPERT_URL, NETWORK_LABEL } from "@/config";
import { AssetLogo } from "@/components/common/AssetLogos";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Wallet, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { GiftStatus } from "@/lib/market/gift";

/** Floor to 4dp so Max never exceeds available after display rounding. */
function floorAmt(n: number, dp = 4): string {
  if (!(n > 0)) return "";
  const f = Math.floor(n * 10 ** dp + 1e-12) / 10 ** dp;
  return f.toFixed(dp);
}

export function DepositWithdrawDialog({
  triggerLabel = "Deposit / Withdraw",
  triggerClassName = "min-h-9 py-2 text-xs leading-tight rounded-[6px] border border-[#1C332C] bg-[#0E1614] hover:border-[#2A4A40] text-[#f5f5f5] px-3 max-w-[100px] text-center transition-colors",
  defaultTab = "deposit",
}: {
  triggerLabel?: string;
  triggerClassName?: string;
  defaultTab?: "deposit" | "withdraw";
} = {}) {
  const { address, setWrongNetwork } = useWalletStore();
  const { sendTransaction } = useWallet();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"deposit" | "withdraw">(defaultTab);
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [assetCode, setAssetCode] = useState(SETTLEMENT_ASSET.code);
  const [addingTrustline, setAddingTrustline] = useState(false);

  const { data: collateral } = useQuery({
    queryKey: ["vaultCollateral"],
    queryFn: listVaultCollateral,
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const assets: ListedCollateral[] = collateral ?? [];
  const asset = assets.find((a) => a.code === assetCode) ?? assets[0];
  const assetAddress = asset?.contract;
  const code = asset?.code ?? "USDC";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const { data: balance } = useQuery({
    queryKey: ["balance", address, assetAddress],
    queryFn: () => getBalance(address!, assetAddress!),
    enabled: !!address && !!assetAddress && open,
    refetchInterval: open ? 8_000 : false,
  });
  const vaultHuman = balance !== undefined ? amountToHuman(balance) : 0;

  const { data: health } = useQuery({
    queryKey: ["health", address],
    queryFn: () => getAccountHealth(address!),
    enabled: !!address && open,
    refetchInterval: open ? 8_000 : false,
  });
  const usedHuman = health ? amountToHuman(health.usedMargin) : 0;
  const freeHuman = health ? amountToHuman(health.freeCollateral) : vaultHuman;

  const { data: venueSnap } = useQuery({
    queryKey: ["venueSnap", address],
    queryFn: () => getVenueSnapshot(address!),
    enabled: !!address && open,
    refetchInterval: open ? 8_000 : false,
  });
  const principalHuman = venueSnap?.principalLeft ?? freeHuman;
  const pendingPayouts = venueSnap?.pendingPayouts ?? [];

  const { data: walletBalance } = useQuery({
    queryKey: ["walletBalance", address, assetAddress],
    queryFn: () => getTokenBalance(address!, assetAddress!),
    enabled: !!address && !!assetAddress && open,
  });
  const walletBalanceHuman = walletBalance !== undefined ? amountToHuman(walletBalance) : null;

  const { data: trustline } = useQuery({
    queryKey: ["trustline", address, assetAddress],
    queryFn: () => hasTrustline(address!, asset!),
    enabled: !!address && !!asset && open,
  });
  const missingTrustline = trustline === false;

  const capHeadroomHuman =
    asset?.capHeadroom === null || asset?.capHeadroom === undefined
      ? null
      : amountToHuman(asset.capHeadroom);

  const { data: giftSnap } = useQuery({
    queryKey: ["gift", address],
    queryFn: async () => {
      const res = await apiFetch(`/api/venue/gift?owner=${encodeURIComponent(address!)}`, { cache: "no-store" });
      if (!res.ok) return { gift: null as GiftStatus | null };
      return (await res.json()) as { gift: GiftStatus | null };
    },
    enabled: !!address && open,
  });
  const giftLocked = Boolean(giftSnap?.gift && !giftSnap.gift.unlocked);

  const maxDeposit = walletBalanceHuman ?? 0;
  // While signup credit is locked, only funded principal may leave — not the gift.
  const instantHuman = Math.max(0, Math.min(freeHuman, principalHuman));
  const maxWithdraw = giftLocked ? instantHuman : Math.max(0, freeHuman);
  const maxForTab = tab === "deposit" ? maxDeposit : maxWithdraw;

  function switchTab(next: "deposit" | "withdraw") {
    setTab(next);
    setAmount("");
  }

  function onAmount(v: string) {
    const cleaned = v.replace(/[^0-9.]/g, "");
    const parts = cleaned.split(".");
    setAmount(parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : cleaned);
  }

  function fillPct(pct: number) {
    const next = floorAmt(maxForTab * (pct / 100));
    if (!next) {
      toast.error(tab === "deposit" ? "Nothing in wallet to deposit" : "No free collateral to withdraw");
      return;
    }
    setAmount(next);
  }

  async function onAddTrustline() {
    if (!address || !asset) return;
    setAddingTrustline(true);
    try {
      const hash = await addTrustline(address, asset);
      toast.success(`${asset.code} trustline added`, {
        action: {
          label: "Explorer",
          onClick: () => window.open(`${STELLAR_EXPERT_URL}/tx/${hash}`, "_blank"),
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["trustline", address] });
      await queryClient.invalidateQueries({ queryKey: ["walletBalance", address] });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setAddingTrustline(false);
    }
  }

  async function run(kind: "deposit" | "withdraw") {
    if (!address || !amount || !asset) return;
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    setWrongNetwork(false);
    const raw =
      kind === "withdraw"
        ? roundToBridgeable(humanToAmount(parsedAmount), asset)
        : humanToAmount(parsedAmount);
    if (raw <= 0n) {
      toast.error("Amount is below the smallest withdrawable unit");
      return;
    }
    setLoading(true);
    try {
      const res =
        kind === "deposit"
          ? await deposit(address, raw, asset.contract, sendTransaction)
          : await withdraw(address, raw, asset.contract);
      if (kind === "withdraw") {
        const w = res as { hash: string; mode?: string; message?: string };
        if (w.mode === "manual") {
          toast.success("Payout queued for admin approval", {
            description:
              w.message ?? "Amount exceeds funded deposits — an operator must accept it.",
          });
        } else {
          toast.success("Withdrawal confirmed", {
            action: {
              label: "Explorer",
              onClick: () =>
                window.open(`${STELLAR_EXPERT_URL}/tx/${w.hash ?? ""}`, "_blank"),
            },
          });
        }
      } else {
        toast.success("Deposit confirmed", {
          action: {
            label: "Explorer",
            onClick: () =>
              window.open(`${STELLAR_EXPERT_URL}/tx/${(res as { hash?: string }).hash ?? ""}`, "_blank"),
          },
        });
      }
      setAmount("");
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["balance", address] });
      queryClient.invalidateQueries({ queryKey: ["walletBalance", address] });
      queryClient.invalidateQueries({ queryKey: ["health", address] });
      queryClient.invalidateQueries({ queryKey: ["venueSnap", address] });
      queryClient.invalidateQueries({ queryKey: ["vaultCollateral"] });
      queryClient.invalidateQueries({ queryKey: ["collateralPositions", address] });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  const amt = parseFloat(amount) || 0;
  const eps = 1e-6;
  const overCap = tab === "deposit" && capHeadroomHuman !== null && amt > capHeadroomHuman + eps;
  const overWallet = tab === "deposit" && walletBalanceHuman !== null && amt > walletBalanceHuman + eps;
  const overFree = tab === "withdraw" && amt > maxWithdraw + eps;
  const overMax = overWallet || overFree;
  const needsManual =
    tab === "withdraw" &&
    amt > 0 &&
    amt > principalHuman + eps &&
    !overFree &&
    !giftLocked;
  const overGiftLock =
    tab === "withdraw" && giftLocked && amt > principalHuman + eps && !overFree;
  const canSubmit =
    !!asset &&
    amt > 0 &&
    !overMax &&
    !overCap &&
    !loading &&
    !overGiftLock &&
    !(tab === "deposit" && missingTrustline);

  const usedPct =
    vaultHuman > 0 ? Math.min(100, Math.max(0, (usedHuman / vaultHuman) * 100)) : 0;

  const ctaLabel = (() => {
    if (addingTrustline) return "Adding trustline…";
    if (loading) return tab === "deposit" ? "Depositing…" : "Withdrawing…";
    if (!asset) return "No collateral listed";
    if (tab === "deposit" && missingTrustline) return `Add ${code} trustline`;
    if (overWallet) return `Not enough ${code} in wallet`;
    if (overCap) return "Over the deposit cap";
    if (overGiftLock) return "Above funded deposits — credit locked";
    if (overFree) {
      return giftLocked
        ? `Only ${formatAccountUsd(maxWithdraw)} withdrawable (credit locked)`
        : "Exceeds available to withdraw";
    }
    if (!(amt > 0)) return tab === "deposit" ? `Enter amount to deposit` : `Enter amount to withdraw`;
    if (needsManual) return `Request payout ${floorAmt(amt)} ${code}`;
    return tab === "deposit" ? `Deposit ${floorAmt(amt)} ${code}` : `Withdraw ${floorAmt(amt)} ${code}`;
  })();

  return (
    <>
      <button
        onClick={() => {
          setTab(defaultTab);
          setAmount("");
          setOpen(true);
        }}
        className={triggerClassName}
      >
        {triggerLabel}
      </button>

      {open && typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-4">
            <div
              className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
              onClick={() => setOpen(false)}
            />
            <div
              className="relative max-h-[92dvh] w-full max-w-full overflow-y-auto rounded-t-2xl border border-[#1C332C] bg-[#070B0A] text-[#f5f5f5] shadow-[0_24px_64px_rgba(0,0,0,.55)] sm:w-[400px] sm:rounded-[16px]"
              style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
            >
              <div className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-[17px] font-bold tracking-tight text-[#f5f5f5]">Collateral</h2>
                    <p className="mt-0.5 text-[11.5px] text-[#6b7c74]">
                      {tab === "deposit" ? "Move USDC from wallet into the vault" : "Move free vault USDC back to wallet"}
                    </p>
                  </div>
                  <button
                    onClick={() => setOpen(false)}
                    aria-label="Close"
                    className="grid h-8 w-8 place-items-center rounded-[8px] text-[#a3a3a3] transition-colors hover:bg-[#12201C] hover:text-[#f5f5f5]"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Tabs */}
                <div className="mt-4 grid grid-cols-2 gap-1 rounded-[12px] border border-[#1C332C] bg-[#0A1210] p-1">
                  {(["deposit", "withdraw"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => switchTab(t)}
                      className={`rounded-[9px] py-2.5 text-[13px] font-semibold capitalize transition-colors ${
                        tab === t
                          ? "bg-[#15221E] text-[#f5f5f5] shadow-[inset_0_0_0_1px_#1C332C]"
                          : "text-[#6b7c74] hover:text-[#c5d4cc]"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>

                {assets.length > 1 && (
                  <div className="mt-3 flex gap-1.5">
                    {assets.map((a) => (
                      <button
                        key={a.code}
                        type="button"
                        onClick={() => {
                          setAssetCode(a.code);
                          setAmount("");
                        }}
                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border px-3 py-2 text-[13px] font-semibold transition-colors ${
                          a.code === assetCode
                            ? "border-[#14F195]/50 bg-[#0E1614] text-[#f5f5f5]"
                            : "border-[#1C332C] bg-[#070B0A] text-[#a3a3a3] hover:text-[#f5f5f5]"
                        }`}
                      >
                        <AssetLogo symbol={a.code} size={15} />
                        {a.code}
                      </button>
                    ))}
                  </div>
                )}

                {/* Account snapshot */}
                <div className="mt-4 overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#0A1210]">
                  <div className="grid grid-cols-2 gap-px bg-[#1C332C]">
                    <SnapCell
                      label="Wallet"
                      value={walletBalanceHuman === null ? "—" : formatAccountUsd(walletBalanceHuman)}
                      icon={<Wallet size={12} className="text-[#6b7c74]" />}
                      onClick={
                        tab === "deposit" && maxDeposit > 0
                          ? () => setAmount(floorAmt(maxDeposit))
                          : undefined
                      }
                      hint={tab === "deposit" ? "Tap to use max" : undefined}
                    />
                    <SnapCell
                      label="Vault equity"
                      value={formatAccountUsd(vaultHuman)}
                    />
                  </div>
                  <div className="space-y-2 px-3.5 py-3">
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="text-[#6b7c74]">In positions</span>
                      <span className="font-mono tabular text-[#f5f5f5]">{formatAccountUsd(usedHuman)}</span>
                    </div>
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="text-[#6b7c74]">Available to withdraw</span>
                      <button
                        type="button"
                        disabled={!(tab === "withdraw" && maxWithdraw > 0)}
                        onClick={() => setAmount(floorAmt(maxWithdraw))}
                        className={`font-mono tabular font-semibold ${
                          tab === "withdraw" && maxWithdraw > 0
                            ? "text-[#14F195] underline decoration-[#14F195]/30 underline-offset-2 hover:decoration-[#14F195]"
                            : "text-[#f5f5f5]"
                        }`}
                        title={tab === "withdraw" ? "Use as amount" : undefined}
                      >
                        {formatAccountUsd(freeHuman)}
                      </button>
                    </div>
                    {tab === "withdraw" && (
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="text-[#6b7c74]">Instant (funded principal)</span>
                        <span className="font-mono tabular text-[#c5d4cc]">
                          {formatAccountUsd(Math.min(freeHuman, principalHuman))}
                        </span>
                      </div>
                    )}
                    {pendingPayouts.length > 0 && (
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="text-amber-400/90">Pending admin payouts</span>
                        <span className="font-mono tabular text-amber-400">
                          {formatAccountUsd(pendingPayouts.reduce((s, p) => s + p.amount, 0))}
                        </span>
                      </div>
                    )}
                    {vaultHuman > 0 && (
                      <div>
                        <div className="mb-1 flex items-center justify-between text-[10px] text-[#6b7c74]">
                          <span>Margin in use</span>
                          <span className="font-mono tabular">{usedPct.toFixed(1)}%</span>
                        </div>
                        <div className="h-[3px] overflow-hidden rounded-full bg-[#12201C]">
                          <div
                            className={`h-full rounded-full ${usedPct > 70 ? "bg-[#FF5C6A]" : "bg-[#14F195]"}`}
                            style={{ width: `${Math.max(usedPct > 0 ? 2 : 0, usedPct)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Flow cue */}
                <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-[#6b7c74]">
                  <span className={tab === "deposit" ? "text-[#c5d4cc]" : ""}>
                    {tab === "deposit" ? "Wallet" : "Available"}
                  </span>
                  <ArrowDown size={12} className="rotate-[-90deg] text-[#14F195]" />
                  <span className={tab === "withdraw" ? "text-[#c5d4cc]" : ""}>
                    {tab === "deposit" ? "Vault" : "Wallet"}
                  </span>
                </div>

                {/* Amount */}
                <div
                  className={`mt-3 rounded-[12px] border bg-[#0E1614] p-4 transition-colors ${
                    overMax ? "border-[#FF5C6A]/50" : "border-[#1C332C]"
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between text-[12px] text-[#a3a3a3]">
                    <span>Amount</span>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      {[25, 50, 75, 100].map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => fillPct(pct)}
                          className="rounded-[6px] border border-[#1C332C] bg-[#0A1210] px-2 py-[3px] font-semibold text-[#8A9B94] transition-colors hover:border-[#2A4A40] hover:text-[#f5f5f5]"
                        >
                          {pct === 100 ? "Max" : `${pct}%`}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <input
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => onAmount(e.target.value)}
                      autoFocus
                      className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[28px] font-semibold tabular text-[#f5f5f5] outline-none placeholder:text-[#2A3A34]"
                    />
                    <span className="flex shrink-0 items-center gap-1.5 text-[15px] font-semibold text-[#f5f5f5]">
                      <AssetLogo symbol={code} size={18} /> {code}
                    </span>
                  </div>
                  {overMax && (
                    <p className="mt-2 text-[11.5px] text-[#FF5C6A]">
                      {overWallet
                        ? `Wallet only has ${formatAccountUsd(maxDeposit)}.`
                        : `Only ${formatAccountUsd(maxWithdraw)} is free — ${formatAccountUsd(usedHuman)} is locked in positions.`}
                    </p>
                  )}
                </div>

                {tab === "withdraw" && usedHuman > 0 && !overMax && (
                  <p className="mt-2 px-0.5 text-[11.5px] leading-snug text-[#6b7c74]">
                    Margin in open positions cannot be withdrawn until you close or reduce them.
                  </p>
                )}
                {needsManual && (
                  <p className="mt-2 rounded-[8px] border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11.5px] leading-snug text-amber-200/90">
                    This amount is above your funded deposits ({formatAccountUsd(principalHuman)}{" "}
                    instant). The rest is profit or gift — submitting queues a manual payout for
                    admin approval.
                  </p>
                )}

                {asset && asset.haircutBps > 0 && (
                  <div className="mt-2 flex items-center justify-between px-0.5 text-[12px]">
                    <span className="text-[#a3a3a3]">Margin haircut</span>
                    <span className="tabular text-[#f5f5f5]">{(asset.haircutBps / 100).toFixed(2)}%</span>
                  </div>
                )}
                {tab === "deposit" && capHeadroomHuman !== null && (
                  <div className="mt-2 flex items-center justify-between px-0.5 text-[12px]">
                    <span className="text-[#a3a3a3]">Remaining capacity</span>
                    <span className="tabular text-[#f5f5f5]">{formatAccountUsd(capHeadroomHuman)}</span>
                  </div>
                )}
                {asset?.note && <p className="mt-2 text-[11.5px] text-[#737373]">{asset.note}</p>}

                {missingTrustline && tab === "deposit" && asset && (
                  <p className="mt-3 rounded-[8px] border border-[#7c5e2a] bg-[#2a2116] px-3 py-2 text-[11.5px] text-[#e8c17a]">
                    Stellar accounts cannot hold an issued asset without a trustline. Adding one is a
                    single signature and costs a small XLM reserve.
                  </p>
                )}

                {giftLocked && tab === "withdraw" && giftSnap?.gift && (
                  <p className="mt-3 rounded-[8px] border border-[#1A2A26] bg-[#0E1614] px-3 py-2 text-[11.5px] leading-snug text-[#8A9B94]">
                    ${giftSnap.gift.amount.toFixed(0)} signup credit stays locked until $
                    {giftSnap.gift.unlockAt.toFixed(0)} realized profit (
                    {Math.max(0, giftSnap.gift.realized).toFixed(2)} / $
                    {giftSnap.gift.unlockAt.toFixed(0)}). You can still withdraw funded deposits
                    up to {formatAccountUsd(instantHuman)}.
                  </p>
                )}

                <button
                  type="button"
                  onClick={() =>
                    tab === "deposit" && missingTrustline ? onAddTrustline() : run(tab)
                  }
                  disabled={
                    addingTrustline ||
                    (tab === "deposit" && missingTrustline ? !asset : !canSubmit)
                  }
                  className="mt-5 h-12 w-full rounded-[10px] bg-[#14F195] text-[14px] font-bold text-[#070B0A] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {ctaLabel}
                </button>

                {(loading || canSubmit) && (
                  <p className="mt-3 text-center text-[11px] text-[#737373]">
                    {loading
                      ? "Confirm in your wallet…"
                      : `Signed via wallet · ${NETWORK_LABEL}`}
                  </p>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function SnapCell({
  label,
  value,
  icon,
  onClick,
  hint,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  onClick?: () => void;
  hint?: string;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={hint}
      className={`bg-[#0A1210] px-3.5 py-3 text-left ${
        onClick ? "transition-colors hover:bg-[#0E1614]" : ""
      }`}
    >
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#6b7c74]">
        {icon}
        {label}
      </div>
      <div className="mt-1 font-mono text-[13px] font-semibold tabular text-[#f5f5f5]">{value}</div>
    </Comp>
  );
}
