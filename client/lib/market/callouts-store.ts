import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Callout, CalloutSide } from "./callouts";

const FILE = join(process.cwd(), ".data", "callouts.json");
const MAX_POSTS = 800;

type State = { posts: Callout[] };

function load(): State {
  const g = globalThis as typeof globalThis & { __floydexCallouts?: State };
  if (g.__floydexCallouts) return g.__floydexCallouts;
  try {
    g.__floydexCallouts = JSON.parse(readFileSync(FILE, "utf8")) as State;
  } catch {
    g.__floydexCallouts = { posts: [] };
  }
  return g.__floydexCallouts;
}

function persist(state: State) {
  try {
    mkdirSync(join(process.cwd(), ".data"), { recursive: true });
    writeFileSync(FILE, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

export function listCallouts(marketId: number, sort: "new" | "top" = "new"): Callout[] {
  const rows = load().posts.filter((p) => p.marketId === marketId);
  if (sort === "top") {
    return rows.sort((a, b) => b.likes.length - a.likes.length || b.createdAt - a.createdAt);
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export function addCallout(args: {
  marketId: number;
  owner: string;
  side: CalloutSide;
  text: string;
}): Callout {
  const state = load();
  const post: Callout = {
    id: randomUUID(),
    marketId: args.marketId,
    owner: args.owner,
    side: args.side,
    text: args.text,
    likes: [],
    createdAt: Date.now(),
  };
  state.posts.unshift(post);
  if (state.posts.length > MAX_POSTS) state.posts.length = MAX_POSTS;
  persist(state);
  return post;
}

export function toggleCalloutLike(id: string, owner: string): Callout | null {
  const state = load();
  const post = state.posts.find((p) => p.id === id);
  if (!post) return null;
  const i = post.likes.indexOf(owner);
  if (i >= 0) post.likes.splice(i, 1);
  else post.likes.push(owner);
  persist(state);
  return post;
}
