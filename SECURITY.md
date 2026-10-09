# Security Policy

## Scope

This policy covers `@fundkeep/sdk`. The contract enforcement itself lives in [`fundkeep-contract`](https://github.com/fundkeep-web/fundkeep-contract), which has its own `SECURITY.md`.

This SDK only builds and helps submit transactions — it never handles private keys or signs anything itself. Signing is always delegated to a wallet-supplied `signTransaction` function (e.g. Freighter's).

## Reporting a Vulnerability

If you find an issue — incorrect transaction construction that could cause unintended fund movement, an argument-encoding bug that silently produces the wrong on-chain call, or a way this package could be tricked into signing/submitting something the caller didn't intend — please report it privately.

Open a private security advisory on this repository (GitHub → Security → Report a vulnerability) rather than a public issue. Include a description, reproduction steps, and impact.

We aim to acknowledge reports within a few days.
