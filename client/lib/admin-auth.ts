const ADMIN_COOKIE = "floydex_admin_session";
/** Short desk sessions — re-auth after idle ops days. */
const MAX_AGE_SEC = 60 * 60 * 4; // 4 hours
/** Reject weak operator passwords even if someone set them in env. */
export const MIN_ADMIN_PASSWORD_LEN = 24;

export { ADMIN_COOKIE };

function adminPassword(): string {
  return (process.env.ADMIN_PASSWORD ?? process.env.ADMIN_API_KEY ?? "").trim();
}

/** Length + mixed case + digit. Special chars encouraged but not required. */
export function isStrongAdminPassword(password: string): boolean {
  if (password.length < MIN_ADMIN_PASSWORD_LEN) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return true;
}

export function adminAuthConfigured(): boolean {
  return isStrongAdminPassword(adminPassword());
}

function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i)! ^ b.charCodeAt(i)!;
  return out === 0;
}

function encodeUtf8(s: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(s);
  const copy = new Uint8Array(encoded.byteLength);
  copy.set(encoded);
  return copy;
}

async function sha256Hex(s: string): Promise<string> {
  const dig = await crypto.subtle.digest("SHA-256", encodeUtf8(s));
  return toBase64Url(dig);
}

async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encodeUtf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encodeUtf8(payload));
  return toBase64Url(sig);
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
  const expected = adminPassword();
  if (!isStrongAdminPassword(expected)) return false;
  // Hash both sides so length differences do not short-circuit the compare.
  const [a, b] = await Promise.all([sha256Hex(password), sha256Hex(expected)]);
  return timingSafeEqualStr(a, b);
}

export async function createAdminSessionToken(): Promise<string> {
  const exp = Date.now() + MAX_AGE_SEC * 1000;
  const payload = `admin.${exp}`;
  const sig = await hmacSign(adminPassword(), payload);
  return `${payload}.${sig}`;
}

export async function verifyAdminSessionToken(
  token: string | undefined | null,
): Promise<boolean> {
  if (!token || !adminAuthConfigured()) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [role, expStr, sig] = parts;
  if (role !== "admin" || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const payload = `${role}.${expStr}`;
  const expected = await hmacSign(adminPassword(), payload);
  return timingSafeEqualStr(sig, expected);
}

export async function readAdminSessionFromRequest(req: {
  cookies: { get: (name: string) => { value: string } | undefined };
  headers: { get: (name: string) => string | null };
}): Promise<boolean> {
  const cookie = req.cookies.get(ADMIN_COOKIE)?.value;
  if (await verifyAdminSessionToken(cookie)) return true;
  // Optional machine header for scripts — never accept password via query string.
  const header = req.headers.get("x-admin-key") ?? "";
  return header.length > 0 && (await verifyAdminPassword(header));
}

export function adminCookieOptions(token: string) {
  return {
    name: ADMIN_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge: MAX_AGE_SEC,
  };
}
