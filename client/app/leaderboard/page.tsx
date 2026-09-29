"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LEADERBOARD_PUBLIC } from "@/lib/market/leaderboard";
import LeaderboardPage from "./LeaderboardPage";

export default function LeaderboardRoute() {
  const router = useRouter();

  useEffect(() => {
    if (!LEADERBOARD_PUBLIC) router.replace("/");
  }, [router]);

  if (!LEADERBOARD_PUBLIC) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#070B0A] text-[13px] text-[#6b7c74]">
        Leaderboard is temporarily offline.
      </div>
    );
  }

  return <LeaderboardPage />;
}
