/**
 * Integration suite: drives `FundKeepClient` against a real Soroban network.
 *
 * `test/client.test.ts` mocks `rpc.Server` end to end, so it proves the client
 * encodes arguments correctly but never proves the resulting transaction is
 * accepted by an RPC. This suite closes that gap: every transaction below is
 * built by the SDK, signed, submitted, and confirmed on a real ledger, and the
 * assertions read state back through `getGoal` rather than through mocks.
 *
 * Gated behind `RUN_INTEGRATION_TESTS=1` so the default `npm test` job — and
 * therefore CI — stays offline and fast. Run it with:
 *
 *   RUN_INTEGRATION_TESTS=1 npm run test:integration
 *
 * See the "Integration tests" section of the README for prerequisites.
 */

import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { FundKeepClient } from "../../src/client.js";
import {
  deployContract,
  deployTestToken,
  fundedKeypair,
  requireEnv,
  sleep,
  waitForAccount,
} from "./helpers.js";

const RUN = process.env.RUN_INTEGRATION_TESTS === "1";

/** USDC-style 7 decimals, matching the SDK's own conversion helpers. */
const ONE_TOKEN = 10_000_000n;

describe.skipIf(!RUN)("FundKeepClient against a real Soroban network", () => {
  let client: FundKeepClient;
  let contractId: string;
  let owner: Keypair;
  let tokenId: string;

  // Ledger closes on testnet are ~5s; give each confirmed write room to land.
  const SETTLE_MS = 3_000;

  beforeAll(async () => {
    owner = await fundedKeypair();
    await waitForAccount(owner.publicKey());

    // An issuer needs its own funded account to deploy and administer the SAC.
    const issuer = await fundedKeypair();
    await waitForAccount(issuer.publicKey());

    // A pre-deployed contract can be supplied to skip the deploy step; this is
    // also what a local `stellar container` run would do.
    contractId = process.env.FUNDKEEP_CONTRACT_ID ?? "";
    if (!contractId) {
      const wasmPath = requireEnv("FUNDKEEP_CONTRACT_WASM");
      contractId = await deployContract(readFileSync(wasmPath), issuer);
    }

    tokenId = await deployTestToken(issuer, owner, 1_000n * ONE_TOKEN);

    client = new FundKeepClient({
      contractId,
      rpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
      networkPassphrase: Networks.TESTNET,
    });
  }, 300_000);

  /**
   * Stand-in for a wallet's `signTransaction`: the suite holds raw keypairs,
   * so it signs the XDR the client produced and hands it straight back.
   */
  const signWith =
    (kp: Keypair) =>
    async (xdr: string, opts?: { networkPassphrase?: string }) => {
      const tx = TransactionBuilder.fromXDR(
        xdr,
        opts?.networkPassphrase ?? Networks.TESTNET
      );
      tx.sign(kp);
      return { signedTxXdr: tx.toXDR() };
    };

  it("runs create → deposit → check_deadline → withdraw against the ledger", async () => {
    // A deadline far enough out that the goal starts locked.
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3_600);

    // ── create ────────────────────────────────────────────────────────────
    const createTx = await client.buildCreateGoalTx({
      owner: owner.publicKey(),
      token: tokenId,
      targetAmount: 2n * ONE_TOKEN,
      deadline,
    });
    const created = await client.signAndSend<number>(
      createTx,
      signWith(owner) as never
    );
    const goalId = Number(created.value);
    expect(created.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(goalId)).toBe(true);

    await sleep(SETTLE_MS);

    // The contract records the goal with the arguments it was given.
    let goal = await client.getGoal(goalId);
    expect(goal.owner).toBe(owner.publicKey());
    expect(goal.token).toBe(tokenId);
    expect(goal.targetAmount).toBe(2n * ONE_TOKEN);
    expect(goal.currentAmount).toBe(0n);
    expect(goal.unlocked).toBe(false);
    expect(goal.withdrawn).toBe(false);

    // ── check_deadline before the deadline ────────────────────────────────
    const preDeadlineTx = await client.buildCheckDeadlineTx({
      source: owner.publicKey(),
      goalId,
    });
    await client.signAndSend(preDeadlineTx, signWith(owner) as never);
    await sleep(SETTLE_MS);

    goal = await client.getGoal(goalId);
    // Still locked: the target is unmet and the deadline has not passed.
    expect(goal.unlocked).toBe(false);

    // ── deposit, below target ─────────────────────────────────────────────
    const depositTx = await client.buildDepositTx({
      caller: owner.publicKey(),
      goalId,
      amount: ONE_TOKEN,
    });
    await client.signAndSend(depositTx, signWith(owner) as never);
    await sleep(SETTLE_MS);

    goal = await client.getGoal(goalId);
    expect(goal.currentAmount).toBe(ONE_TOKEN);
    expect(goal.unlocked).toBe(false);

    // ── withdraw before unlock must fail ──────────────────────────────────
    // The contract rejects this with `NotUnlocked` (error code 2). Because the
    // operation is a Soroban call, the failure surfaces during the RPC's
    // simulation inside `buildWithdrawTx` — the transaction never reaches the
    // signer. Asserting the typed error also covers `parseContractError`,
    // which is what turns the host error into a `FundKeepError`.
    await expect(
      client.buildWithdrawTx({ caller: owner.publicKey(), goalId })
    ).rejects.toThrow(/NotUnlocked|not unlocked|Error\(Contract, #2\)/i);

    // ── deposit the rest, which reaches the target and auto-unlocks ───────
    const topUpTx = await client.buildDepositTx({
      caller: owner.publicKey(),
      goalId,
      amount: ONE_TOKEN,
    });
    await client.signAndSend(topUpTx, signWith(owner) as never);
    await sleep(SETTLE_MS);

    goal = await client.getGoal(goalId);
    expect(goal.currentAmount).toBe(2n * ONE_TOKEN);
    // `deposit` auto-unlocks when the target is reached.
    expect(goal.unlocked).toBe(true);

    // ── withdraw after unlock succeeds ────────────────────────────────────
    const withdrawTx = await client.buildWithdrawTx({
      caller: owner.publicKey(),
      goalId,
    });
    await client.signAndSend(withdrawTx, signWith(owner) as never);
    await sleep(SETTLE_MS);

    goal = await client.getGoal(goalId);
    expect(goal.withdrawn).toBe(true);

    // ── check_deadline on a withdrawn goal is a defined error, not a crash ─
    // The contract returns `AlreadyWithdrawn` (error code 3). Like the other
    // contract-level reverts, it is detected during simulation, so it surfaces
    // from the build call rather than at submit. The point of this assertion is
    // that the failure is a typed contract error the caller can act on, not an
    // opaque decode failure.
    await expect(
      client.buildCheckDeadlineTx({ source: owner.publicKey(), goalId })
    ).rejects.toThrow(/AlreadyWithdrawn|already withdrawn|Error\(Contract, #3\)/i);

    // State is unchanged by that last call.
    const final = await client.getGoal(goalId);
    expect(final.withdrawn).toBe(true);
  }, 300_000);

  it("rejects a deposit from an address that is not the owner", async () => {
    const stranger = await fundedKeypair();
    await waitForAccount(stranger.publicKey());

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3_600);
    const createTx = await client.buildCreateGoalTx({
      owner: owner.publicKey(),
      token: tokenId,
      targetAmount: 2n * ONE_TOKEN,
      deadline,
    });
    const created = await client.signAndSend<number>(
      createTx,
      signWith(owner) as never
    );
    const goalId = Number(created.value);
    await sleep(SETTLE_MS);

    // The contract requires auth from the goal's owner and returns
    // `Unauthorized` (error code 4). As above, the revert is detected during
    // simulation, so it surfaces from the build call rather than at submit.
    await expect(
      client.buildDepositTx({
        caller: stranger.publicKey(),
        goalId,
        amount: ONE_TOKEN,
      })
    ).rejects.toThrow(/Unauthorized|unauthorized|Error\(Contract, #4\)/i);

    const goal = await client.getGoal(goalId);
    expect(goal.currentAmount).toBe(0n);
  }, 300_000);
});
