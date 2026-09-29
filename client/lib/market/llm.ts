export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmReply = {
  text: string;
  provider: string;
  model: string;
};

type Provider = {
  id: string;
  url: string;
  headers: Record<string, string>;
  model: string;
  timeoutMs: number;
  extra?: Record<string, unknown>;
};

const SKIP_MS: Record<string, number> = {
  usepod: 10 * 60_000,
  openai: 3 * 60_000,
  groq: 3 * 60_000,
  gemini: 3 * 60_000,
  public: 45_000,
};

const skippedUntil = new Map<string, number>();

function listProviders(): Provider[] {
  const out: Provider[] = [];
  const usepod = process.env.USEPOD_API_TOKEN?.trim();
  if (usepod) {
    out.push({
      id: "usepod",
      url: `https://api.usepod.ai/proxy/${usepod}/v1/chat/completions`,
      headers: { "content-type": "application/json" },
      model: process.env.USEPOD_MODEL?.trim() || "deepseek-v3.2",
      timeoutMs: 8_000,
      extra: { usepod: { routes: ["marketplace", "commercial"], fallback: "explicit" } },
    });
  }
  const openai = process.env.OPENAI_API_KEY?.trim();
  if (openai) {
    out.push({
      id: "openai",
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${openai}`,
      },
      model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
      timeoutMs: 18_000,
    });
  }
  const groq = process.env.GROQ_API_KEY?.trim();
  if (groq) {
    out.push({
      id: "groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${groq}`,
      },
      model: process.env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile",
      timeoutMs: 18_000,
    });
  }
  const gemini = (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY)?.trim();
  if (gemini) {
    out.push({
      id: "gemini",
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gemini}`,
      },
      model: process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash",
      timeoutMs: 18_000,
    });
  }
  // Last-resort OpenAI-compatible public desk so the terminal still talks
  // when UsePod is not activated and no operator key is set.
  out.push({
    id: "public",
    url: "https://text.pollinations.ai/openai",
    headers: { "content-type": "application/json" },
    model: process.env.PUBLIC_LLM_MODEL?.trim() || "openai",
    timeoutMs: 40_000,
  });
  return out;
}

function skip(id: string) {
  skippedUntil.set(id, Date.now() + (SKIP_MS[id] ?? 60_000));
}

async function tryProvider(
  provider: Provider,
  messages: LlmMessage[],
  maxTokens: number,
): Promise<LlmReply | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), provider.timeoutMs);
  try {
    const res = await fetch(provider.url, {
      method: "POST",
      headers: {
        ...provider.headers,
        "user-agent": "FloyDex/1.0",
      },
      cache: "no-store",
      signal: ctrl.signal,
      body: JSON.stringify({
        model: provider.model,
        max_tokens: maxTokens,
        temperature: 0.35,
        messages,
        ...(provider.extra ?? {}),
      }),
    });
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      skip(provider.id);
      return null;
    }
    if (!res.ok) {
      if (res.status >= 500 && provider.id !== "public") skip(provider.id);
      return null;
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | Array<{ text?: string }> } }[];
      model?: string;
    };
    const raw = json.choices?.[0]?.message?.content;
    const text = Array.isArray(raw)
      ? raw.map((p) => p.text ?? "").join("").trim()
      : (raw ?? "").trim();
    if (!text) return null;
    return { text, provider: provider.id, model: json.model || provider.model };
  } catch {
    if (provider.id !== "public") skip(provider.id);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function completeChat(
  messages: LlmMessage[],
  opts?: { maxTokens?: number },
): Promise<LlmReply | null> {
  const now = Date.now();
  const maxTokens = opts?.maxTokens ?? 420;
  for (const provider of listProviders()) {
    if ((skippedUntil.get(provider.id) ?? 0) > now) continue;
    const reply = await tryProvider(provider, messages, maxTokens);
    if (reply) return reply;
  }
  return null;
}
