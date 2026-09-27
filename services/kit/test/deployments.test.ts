import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
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
  const calendarAuthority = Keypair.generate().publicKey;
  const settlementMint = Keypair.generate().publicKey;
  const wrongMint = Keypair.generate().publicKey;

  const deployment = {
    cluster: "devnet",
    programId: Keypair.generate().publicKey.toBase58(),
    usdcMint: wrongMint.toBase58(),
    accounts: { guardian: Keypair.generate().publicKey.toBase58(), calendarAuthority: calendarAuthority.toBase58() },
  };

  const problems = compareExchangeState(deployment, {
    admin: Keypair.generate().publicKey,
    guardian,
    calendarAuthority,
    settlementMint,
    paused: false,
  });

  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /guardian/);
  assert.match(problems.join("\n"), /settlementMint/);
});

test("compareExchangeState is clean when everything recorded agrees", () => {
  const guardian = Keypair.generate().publicKey;
  const calendarAuthority = Keypair.generate().publicKey;
  const settlementMint = Keypair.generate().publicKey;

  const deployment = {
    cluster: "devnet",
    programId: Keypair.generate().publicKey.toBase58(),
    usdcMint: settlementMint.toBase58(),
    accounts: { guardian: guardian.toBase58(), calendarAuthority: calendarAuthority.toBase58() },
  };

  const problems = compareExchangeState(deployment, {
    admin: Keypair.generate().publicKey,
    guardian,
    calendarAuthority,
    settlementMint,
    paused: false,
  });
  assert.deepEqual(problems, []);
});
