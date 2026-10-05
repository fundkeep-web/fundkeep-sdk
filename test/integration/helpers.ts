/**
 * Helpers for the integration suite.
 *
 * Everything here talks to a real network. Nothing in this directory runs as
 * part of the default `npm test`; see `describe.skipIf` in the spec and the
 * `RUN_INTEGRATION_TESTS` gate described in the README.
 */

import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

/** Read an env var, or throw a message that says which one is missing. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Integration tests need ${name}. See the "Integration tests" section of the README.`
    );
  }
  return value;
}

export const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

export const NETWORK_PASSPHRASE = Networks.TESTNET;

export function server(): rpc.Server {
  return new rpc.Server(RPC_URL);
}

/**
 * Fund a fresh keypair through Friendbot, then return it. Only valid against
 * testnet or a local network that exposes a Friendbot.
 */
export async function fundedKeypair(friendbotUrl?: string): Promise<Keypair> {
  const kp = Keypair.random();
  const base =
    friendbotUrl ??
    process.env.FRIENDBOT_URL ??
    "https://friendbot.stellar.org";
  const url = `${base}?addr=${encodeURIComponent(kp.publicKey())}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Friendbot refused to fund ${kp.publicKey()}: ${res.status} ${await res.text()}`
    );
  }
  return kp;
}

/**
 * Wait until the given account is visible to the RPC's view of the ledger.
 * Friendbot returns before the ledger closes, so `getAccount` can 404 for a
 * few seconds after funding.
 */
export async function waitForAccount(
  publicKey: string,
  timeoutMs = 60_000
): Promise<void> {
  const srv = server();
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await srv.getAccount(publicKey);
      return;
    } catch (err) {
      lastError = err;
      await sleep(2_000);
    }
  }
  throw new Error(
    `Account ${publicKey} never appeared on the ledger: ${String(lastError)}`
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deploy a contract from wasm and return its contract id (C...).
 *
 * Soroban's deploy is an upload plus a create, submitted as one transaction
 * by the RPC's `prepareTransaction`; the CLI wraps this, and so do we.
 */
export async function deployContract(
  wasm: Buffer,
  source: Keypair
): Promise<string> {
  const srv = server();
  const account = await srv.getAccount(source.publicKey());

  const uploadTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(60)
    .build();

  const preparedUpload = await srv.prepareTransaction(uploadTx);
  preparedUpload.sign(source);
  const uploadResult = await srv.sendTransaction(preparedUpload);

  if (uploadResult.status === "ERROR") {
    throw new Error(`wasm upload failed: ${JSON.stringify(uploadResult)}`);
  }

  const uploadOutcome = await pollUntilDone(uploadResult.hash);
  const wasmHash = scValToNative(uploadOutcome.returnValue!) as Buffer;

  // The second transaction has to be built against the account as it is now,
  // after the first one consumed a sequence number.
  const accountAfterUpload = await srv.getAccount(source.publicKey());
  const salt = Buffer.from(Keypair.random().rawPublicKey());

  const createTx = new TransactionBuilder(accountAfterUpload, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.createCustomContract({
        address: new Address(source.publicKey()),
        wasmHash,
        salt,
      })
    )
    .setTimeout(60)
    .build();

  const preparedCreate = await srv.prepareTransaction(createTx);
  preparedCreate.sign(source);
  const createResult = await srv.sendTransaction(preparedCreate);

  if (createResult.status === "ERROR") {
    throw new Error(`contract create failed: ${JSON.stringify(createResult)}`);
  }

  const createOutcome = await pollUntilDone(createResult.hash);
  const contractAddress = scValToNative(createOutcome.returnValue!) as string;
  return contractAddress;
}

/** Poll a submitted transaction until it is no longer NOT_FOUND. */
export async function pollUntilDone(hash: string, timeoutMs = 90_000) {
  const srv = server();
  const deadline = Date.now() + timeoutMs;
  let last: unknown;

  while (Date.now() < deadline) {
    const res = await srv.getTransaction(hash);
    last = res;
    if (res.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`transaction ${hash} ended as ${res.status}`);
      }
      return res;
    }
    await sleep(2_000);
  }
  throw new Error(`transaction ${hash} never settled: ${JSON.stringify(last)}`);
}

/**
 * Deploy a Stellar Asset Contract for a test asset and mint `amount` to
 * `recipient`. Returns the SAC's contract address, which is what the FundKeep
 * contract takes as its `token`.
 */
export async function deployTestToken(
  source: Keypair,
  recipient: Keypair,
  amount: bigint
): Promise<string> {
  const srv = server();
  const asset = new Asset(
    `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    source.publicKey()
  );

  // ── 1. deploy the Stellar Asset Contract ────────────────────────────────
  const account = await srv.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.createStellarAssetContract({ asset }))
    .setTimeout(60)
    .build();

  const prepared = await srv.prepareTransaction(tx);
  prepared.sign(source);
  const sent = await srv.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`SAC deploy failed: ${JSON.stringify(sent)}`);
  }
  const outcome = await pollUntilDone(sent.hash);
  const sacId = scValToNative(outcome.returnValue!) as string;

  // ── 2. trustline, then mint ─────────────────────────────────────────────
  // A SAC enforces the classic rule that an account must trust an asset
  // before holding it, so `mint` reverts with "trustline entry is missing"
  // without this step.
  //
  // `changeTrust` is a classic operation, and the Soroban RPC's
  // `prepareTransaction` only accepts Soroban host-function operations — it
  // rejects this with "unsupported operation type". Classic operations go
  // through Horizon instead.
  await establishTrustline(asset, recipient);
  await mintSac(srv, sacId, recipient.publicKey(), amount, source);

  return sacId;
}

/** Submit a classic changeTrust for `asset` on behalf of `holder`. */
async function establishTrustline(asset: Asset, holder: Keypair): Promise<void> {
  const horizonUrl =
    process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
  const res = await fetch(`${horizonUrl}/accounts/${holder.publicKey()}`);
  if (!res.ok) {
    throw new Error(
      `Horizon could not load ${holder.publicKey()}: ${res.status}`
    );
  }
  const { sequence } = (await res.json()) as { sequence: string };

  const account = new Account(holder.publicKey(), sequence);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();
  tx.sign(holder);

  const submit = await fetch(`${horizonUrl}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `tx=${encodeURIComponent(tx.toEnvelope().toXDR("base64"))}`,
  });
  if (!submit.ok) {
    throw new Error(
      `changeTrust failed: ${submit.status} ${await submit.text()}`
    );
  }
}

/** Invoke `mint` on the SAC as its admin. */
async function mintSac(
  srv: rpc.Server,
  sacId: string,
  recipient: string,
  amount: bigint,
  admin: Keypair
): Promise<void> {
  const sac = new Contract(sacId);
  const account = await srv.getAccount(admin.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      sac.call(
        "mint",
        nativeToScVal(recipient, { type: "address" }),
        nativeToScVal(amount, { type: "i128" })
      )
    )
    .setTimeout(60)
    .build();

  const prepared = await srv.prepareTransaction(tx);
  prepared.sign(admin);
  const sent = await srv.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`mint failed: ${JSON.stringify(sent)}`);
  }
  await pollUntilDone(sent.hash);
}

// Re-exported so specs do not need a second import block.
export { rpc, scValToNative, nativeToScVal };
