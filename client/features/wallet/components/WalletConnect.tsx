"use client";

import { useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useWalletStore } from "@/stores/wallet";
import { shortenAddress } from "@/lib/format";
import { toast } from "sonner";
import { NETWORK_LABEL } from "@/config";
import { DepositWithdrawDialog } from "@/features/trade/components/DepositWithdrawDialog";
import { GIFT_UNLOCK_PROFIT, GIFT_USD } from "@/lib/market/gift";

export function WalletConnect() {
  const { publicKey, connected, connecting, disconnect, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  const { setAddress, setConnected, setConnecting, setWrongNetwork, disconnect: clearStore } =
    useWalletStore();

  useEffect(() => {
    const addr = publicKey?.toBase58() ?? null;
    setAddress(addr);
    setConnected(Boolean(connected && addr));
    setConnecting(connecting);
    setWrongNetwork(false);
  }, [publicKey, connected, connecting, setAddress, setConnected, setConnecting, setWrongNetwork]);

  if (!connected || !publicKey) {
    return (
      <div className="flex items-center gap-1.5">
        <GiftBonusMark onClick={() => setVisible(true)} />
        <button
          onClick={() => setVisible(true)}
          disabled={connecting}
          className="shrink-0 whitespace-nowrap rounded-[7px] bg-[#14F195] px-2.5 py-[7px] text-[12.5px] font-semibold text-[#050807] transition-colors hover:bg-[#3DFFB0] disabled:opacity-50 sm:px-4 sm:py-[8px] sm:text-[13px]"
        >
          {connecting ? "Connecting…" : (
            <>
              <span className="sm:hidden">Connect</span>
              <span className="hidden sm:inline">Connect Wallet</span>
            </>
          )}
        </button>
      </div>
    );
  }

  async function handleDisconnect() {
    try {
      await disconnect();
    } finally {
      clearStore();
      toast.success("Wallet disconnected");
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <DepositWithdrawDialog
        triggerLabel="Deposit / Withdraw"
        triggerClassName="shrink-0 whitespace-nowrap rounded-[7px] border border-[#1A2A26] bg-[#0E1614] px-2.5 py-2 text-[11.5px] font-medium text-[#f5f5f5] transition-colors hover:border-[#2A4A40] hover:text-[#14F195] sm:px-3 sm:py-[8px] sm:text-[13px]"
      />
      <button
        onClick={handleDisconnect}
        title={wallet?.adapter.name ? `${wallet.adapter.name} on ${NETWORK_LABEL} — click to disconnect` : "Click to disconnect"}
        className="flex shrink-0 items-center rounded-[7px] border border-[#1A2A26] bg-[#0E1614] px-3 py-2 transition-colors group hover:border-red-500/40 hover:bg-red-500/5 sm:px-[18px] sm:py-[8px]"
      >
        <span className="font-mono text-[12.5px] text-[#f5f5f5] group-hover:text-red-400 transition-colors sm:text-[14px]">
          {shortenAddress(publicKey.toBase58())}
        </span>
      </button>
    </div>
  );
}

function GiftBonusMark({ onClick }: { onClick: () => void }) {
  const label = `$${GIFT_USD} welcome bonus · one per IP and device · withdraw after $${GIFT_UNLOCK_PROFIT} profit`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="relative grid h-8 w-8 shrink-0 place-items-center overflow-visible transition-transform hover:scale-105 sm:h-9 sm:w-9"
    >
      <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden className="overflow-visible sm:h-[30px] sm:w-[30px]">
        <ellipse cx="16" cy="29.4" rx="8.5" ry="1.3" fill="#050807" opacity="0.4" />
        <rect x="6.5" y="15" width="19" height="13" rx="2.2" fill="#12C77A" />
        <rect x="6.5" y="15" width="19" height="4.2" fill="#14F195" />
        <rect x="5" y="10.4" width="22" height="5.6" rx="1.8" fill="#3DFFB0" />
        <rect x="14.5" y="10.4" width="3" height="17.6" fill="#E8A317" />
        <rect x="5" y="12.4" width="22" height="2" fill="#E8A317" />
        <ellipse cx="11.6" cy="8.6" rx="4.4" ry="2.5" transform="rotate(-32 11.6 8.6)" fill="#FFC14A" />
        <ellipse cx="20.4" cy="8.6" rx="4.4" ry="2.5" transform="rotate(32 20.4 8.6)" fill="#FFC14A" />
        <ellipse cx="11.6" cy="8.6" rx="2.2" ry="1.1" transform="rotate(-32 11.6 8.6)" fill="#FFE08A" />
        <ellipse cx="20.4" cy="8.6" rx="2.2" ry="1.1" transform="rotate(32 20.4 8.6)" fill="#FFE08A" />
        <circle cx="16" cy="9.3" r="2" fill="#E8A317" />
        <circle cx="16" cy="9.3" r="1" fill="#FFE08A" />
      </svg>
      <span className="absolute -right-1 top-0 rounded-full bg-[#FF5C6A] px-[5px] py-[1px] text-[9px] font-bold leading-none text-white shadow-[0_1px_2px_rgba(0,0,0,.45)]">
        ${GIFT_USD}
      </span>
    </button>
  );
}
