"use client";

const KEY = "floydex-device";

export function deviceId(): string {
  if (typeof window === "undefined") return "";
  let id = window.localStorage.getItem(KEY);
  if (!id || id.length < 8) {
    id = window.crypto.randomUUID();
    window.localStorage.setItem(KEY, id);
  }
  document.cookie = `${KEY}=${id};path=/;max-age=31536000;samesite=lax`;
  return id;
}

