import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { loadDeployment, DeploymentFileError, deriveExchangePda, compareExchangeState } from "../src/deployments.ts";

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kryon-deployments-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

test("loadDeployment parses a valid file", () => {
  const programId = Keypair.generate().publicKey.toBase58();
  const path = tmpFile("devnet.json", JSON.stringify({ cluster: "devnet", programId }));
  const rec = loadDeployment(path);
  assert.equal(rec.programId, programId);
});

test("loadDeployment rejects missing file, bad JSON, and a missing/invalid programId", () => {
  assert.throws(() => loadDeployment("/no/such/file.json"), DeploymentFileError);

  const badJson = tmpFile("bad.json", "{ not json");
  assert.throws(() => loadDeployment(badJson), DeploymentFileError);

  const noProgramId = tmpFile("no-id.json", JSON.stringify({ cluster: "devnet" }));
  assert.throws(() => loadDeployment(noProgramId), DeploymentFileError);

  const badProgramId = tmpFile("bad-id.json", JSON.stringify({ cluster: "devnet", programId: "not-a-pubkey" }));
  assert.throws(() => loadDeployment(badProgramId), DeploymentFileError);
});

test("deriveExchangePda is deterministic for a given program id", () => {
  const programId = Keypair.generate().publicKey;
  const a = deriveExchangePda(programId);
  const b = deriveExchangePda(programId);
  assert.ok(a.equals(b));
});

test("compareExchangeState flags a mismatched guardian, calendar authority, or settlement mint", () => {
  const guardian = Keypair.generate().publicKey;
  const calendar_authority = Keypair.generate().publicKey;
  const settlement_mint = Keypair.generate().publicKey;
  const wrongMint = Keypair.generate().publicKey;

  const deployment = {
    cluster: "devnet",
    programId: Keypair.generate().publicKey.toBase58(),
    usdcMint: wrongMint.toBase58(),
    accounts: { guardian: Keypair.generate().publicKey.toBase58(), calendarAuthority: calendar_authority.toBase58() },
  };

  const problems = compareExchangeState(deployment, {
    admin: Keypair.generate().publicKey,
    guardian,
    calendar_authority,
    settlement_mint,
    paused: false,
  });

  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /guardian/);
  assert.match(problems.join("\n"), /settlementMint/);
});

test("compareExchangeState is clean when everything recorded agrees", () => {
  const guardian = Keypair.generate().publicKey;
  const calendar_authority = Keypair.generate().publicKey;
  const settlement_mint = Keypair.generate().publicKey;

  const deployment = {
    cluster: "devnet",
    programId: Keypair.generate().publicKey.toBase58(),
    usdcMint: settlement_mint.toBase58(),
    accounts: { guardian: guardian.toBase58(), calendarAuthority: calendar_authority.toBase58() },
  };

  const problems = compareExchangeState(deployment, {
    admin: Keypair.generate().publicKey,
    guardian,
    calendar_authority,
    settlement_mint,
    paused: false,
  });
  assert.deepEqual(problems, []);
});

// Regression test for a real bug caught while building this: the Borsh
// account coder decodes fields under their IDL names VERBATIM (snake_case
// here), not camelCased. compareExchangeState's own unit tests above pass
// fake objects it fabricates itself, so they can't catch a mismatch between
// what the coder actually returns and what compareExchangeState expects —
// only a round-trip through the real coder, against a real (trimmed) IDL,
// can. The fixture is a frozen excerpt of target/idl/kryon_perps.json's
// Exchange account, not a live build artifact, so this runs without
// `yarn build` having been run first.
test("a real Anchor-decoded Exchange account has the field names compareExchangeState expects", async () => {
  const idl = JSON.parse(readFileSync(new URL("./fixtures/exchange-idl.json", import.meta.url), "utf8"));
  const coder = new BorshAccountsCoder(idl);
  const guardian = Keypair.generate().publicKey;
  const calendarAuthority = Keypair.generate().publicKey;
  const settlementMint = Keypair.generate().publicKey;
  const zero = PublicKey.default;

  const encoded = await coder.encode("Exchange", {
    admin: zero,
    pending_admin: zero,
    guardian,
    operators: [zero, zero, zero, zero],
    calendar_authority: calendarAuthority,
    paused: false,
    fee_config: { maker_fee_bps: 0, taker_fee_bps: 0 },
    insurance: zero,
    domain: new Array(32).fill(0),
    max_total_oi_policy_bps: 0,
    total_oi_policy_bps: 0,
    settlement_mint: settlementMint,
    settlement_collateral_index: 0,
    collateral_count: 0,
    bump: 0,
    max_reward_bps: 0,
    partial_liquidation_bps: 0,
    _reserved: new Array(56).fill(0),
  });

  const decoded = coder.decode("Exchange", encoded);
  const problems = compareExchangeState(
    {
      cluster: "devnet",
      programId: Keypair.generate().publicKey.toBase58(),
      usdcMint: settlementMint.toBase58(),
      accounts: { guardian: guardian.toBase58(), calendarAuthority: calendarAuthority.toBase58() },
    },
    decoded,
  );
  assert.deepEqual(problems, []);
});
