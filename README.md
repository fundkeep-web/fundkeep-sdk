# @fundkeep/sdk

TypeScript client for the [FundKeep](https://github.com/fundkeep-web/fundkeep-app) Soroban savings-goal contract ([fundkeep-contract](https://github.com/fundkeep-web/fundkeep-contract)). Builds unsigned transactions, leaves signing to the caller's wallet, and helps submit and decode the result.

**Testnet:** [`CBYUM...DDFAH`](https://stellar.expert/explorer/testnet/contract/CBYUMUNDBGT5JTYX62SSFH5NTK2ELLRT2PP3LLZOI757JB4BULDDDFAH) · **App:** [fundkeep.vercel.app](https://fundkeep.vercel.app) · **Docs:** [entity-6.gitbook.io/fundkeep](https://entity-6.gitbook.io/fundkeep)

Not published to npm — install directly from GitHub:

```bash
npm install github:fundkeep-web/fundkeep-sdk
```

## Requirements

- Node.js v22.12+

## Usage

```ts
import { FundKeepClient, toStroops, fromStroops } from "@fundkeep/sdk";
import { signTransaction } from "@stellar/freighter-api";
import { Networks } from "@stellar/stellar-sdk";

const client = new FundKeepClient({
  contractId: process.env.NEXT_PUBLIC_CONTRACT_ID!,
  rpcUrl: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL!,
  networkPassphrase: Networks.TESTNET,
});

// Read (no wallet needed)
const goal = await client.getGoal(0);
console.log(fromStroops(goal.currentAmount), "/", fromStroops(goal.targetAmount));

// Write (needs a connected wallet)
const tx = await client.buildDepositTx({
  caller: walletAddress,
  goalId: 0,
  amount: toStroops("25.5"),
});
const { hash, value } = await client.signAndSend(tx, signTransaction, {
  address: walletAddress,
});
```

## API

- `buildCreateGoalTx({ owner, token, targetAmount, deadline })`
- `buildDepositTx({ caller, goalId, amount })`
- `buildCheckDeadlineTx({ source, goalId })`
- `buildWithdrawTx({ caller, goalId })`
- `getGoal(goalId)` — read-only, no wallet or funded account required
- `signAndSend(tx, signTransaction, opts?)` — signs with a Freighter-shaped `signTransaction`, submits, and polls until confirmed
- `toStroops(amount)` / `fromStroops(stroops)` — USDC's 7-decimal conversion
- `parseContractError(source)` — turns an RPC error into a typed `FundKeepError` with a `.code` matching [`fundkeep-contract`'s error enum](https://github.com/fundkeep-web/fundkeep-contract/blob/main/contracts/fundkeep/src/errors.rs)

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
```

## Integration tests

`npm test` mocks the RPC end to end: it proves the client encodes arguments
correctly, but it never proves a built transaction is accepted by a real
network. The integration suite closes that gap by building, signing,
submitting and confirming real transactions, then reading state back through
`getGoal`.

It is **off by default** — `npm test` and CI never reach the network. Enable it
explicitly:

```bash
RUN_INTEGRATION_TESTS=1 npm run test:integration
```

### Prerequisites

- **A network.** Either a local one (`stellar container start local`) or
  Stellar Testnet. Testnet is the default and needs no local tooling.
- **A deployed FundKeep contract.** Either a local instance or a known-good
  testnet contract id. If you don't have one, deploy it:

  ```bash
  git clone https://github.com/fundkeep-web/fundkeep-contract
  cd fundkeep-contract
  cargo build --target wasm32v1-none --release --package fundkeep-contract
  stellar keys generate deployer --network testnet --fund
  stellar contract deploy \
    --wasm target/wasm32v1-none/release/fundkeep_contract.wasm \
    --source deployer --network testnet
  ```

- **Node 22+**, which supplies the global `fetch` the helpers use for Friendbot.

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RUN_INTEGRATION_TESTS` | yes | — | Must be `1`; the suite is skipped otherwise |
| `FUNDKEEP_CONTRACT_ID` | yes* | — | Contract to exercise (`C...`) |
| `FUNDKEEP_CONTRACT_WASM` | yes* | — | Path to `fundkeep_contract.wasm`, used to deploy a throwaway contract |
| `SOROBAN_RPC_URL` | no | `https://soroban-testnet.stellar.org` | RPC endpoint |
| `FRIENDBOT_URL` | no | `https://friendbot.stellar.org` | Funds the throwaway accounts |

\* Supply **one** of `FUNDKEEP_CONTRACT_ID` or `FUNDKEEP_CONTRACT_WASM`. With
the wasm path the suite deploys its own contract, which is the safer option
against a shared testnet — nothing is reused between runs.

### Example

```bash
export FUNDKEEP_CONTRACT_WASM=../fundkeep-contract/target/wasm32v1-none/release/fundkeep_contract.wasm
RUN_INTEGRATION_TESTS=1 npm run test:integration
```

The suite creates its own funded keypairs through Friendbot, deploys a fresh
SAC for the token, and walks a goal through
`create → deposit → check_deadline → withdraw`, asserting `getGoal` reflects
each step and that a premature `withdraw` is rejected.

> These tests spend testnet XLM and take a couple of minutes: every write waits
> for a ledger close. Point them at a local network if you need them faster.
