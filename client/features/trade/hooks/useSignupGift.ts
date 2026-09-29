"use client";

import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { deviceId } from "@/lib/device";
import type { GiftStatus } from "@/lib/market/gift";
import { useWalletStore } from "@/stores/wallet";

export function useSignupGift({ autoClaim = false }: { autoClaim?: boolean } = {}) {
  const { address, connected } = useWalletStore();
  const queryClient = useQueryClient();
  const tried = useRef<string | null>(null);

  const { data } = useQuery({
    queryKey: ["gift", address],
    enabled: !!address && connected,
    queryFn: async () => {
      const res = await apiFetch(`/api/venue/gift?owner=${encodeURIComponent(address!)}`, { cache: "no-store" });
      if (!res.ok) return { gift: null as GiftStatus | null };
      return (await res.json()) as { gift: GiftStatus | null };
    },
    refetchInterval: 15_000,
  });

  const claim = useMutation({
    mutationFn: async (manual: boolean) => {
      const res = await apiFetch("/api/venue/gift", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: address, deviceId: deviceId() }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        claimed?: boolean;
        error?: string;
        gift?: GiftStatus | null;
      };
      if (!res.ok && !json.error) throw new Error("Could not claim");
      return { ...json, manual };
    },
    onSuccess: (json) => {
      queryClient.invalidateQueries({ queryKey: ["gift", address] });
      queryClient.invalidateQueries({ queryKey: ["health", address] });
      queryClient.invalidateQueries({ queryKey: ["balance", address] });
      queryClient.invalidateQueries({ queryKey: ["collateralPositions"] });
      if (!json.claimed && json.manual && json.error) toast.error(json.error);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const mutate = claim.mutate;
  useEffect(() => {
    if (!autoClaim || !connected || !address || tried.current === address) return;
    tried.current = address;
    mutate(false);
  }, [autoClaim, connected, address, mutate]);

  const gift = data?.gift ?? null;
  return {
    gift,
    connected,
    claiming: claim.isPending,
    claim: () => claim.mutate(true),
    showPromo: !gift?.unlocked,
  };
}
