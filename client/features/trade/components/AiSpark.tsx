"use client";

import { useId } from "react";

export function AiSpark({
  active = false,
  busy = false,
  size = 22,
}: {
  active?: boolean;
  busy?: boolean;
  size?: number;
}) {
  const raw = useId().replace(/[^a-zA-Z0-9]/g, "");
  const gid = `ai-spark-${raw}`;
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden
      className={`floy-ai-spark ${active ? "is-on" : ""} ${busy ? "is-busy" : ""}`}
    >
      <defs>
        <linearGradient id={gid} x1="8%" y1="0%" x2="92%" y2="100%">
          <stop offset="0%" stopColor="#9B6CFF" />
          <stop offset="48%" stopColor="#6B7CFF" />
          <stop offset="100%" stopColor="#3D9BFF" />
        </linearGradient>
        <filter id={`${gid}-glow`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="1.4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path
        filter={`url(#${gid}-glow)`}
        fill={`url(#${gid})`}
        d="M16 1.2c.55 6.4 2.2 10.6 7.6 13.2 1.7.8 4.4 1.4 7.2 1.6-2.8.3-5.5.9-7.2 1.7-5.4 2.6-7.05 6.8-7.6 13.1-.55-6.3-2.2-10.5-7.6-13.1C7.3 16.9 4.6 16.3 1.8 16c2.8-.2 5.5-.8 7.2-1.6C14.4 11.8 16.05 7.6 16 1.2z"
      />
    </svg>
  );
}
