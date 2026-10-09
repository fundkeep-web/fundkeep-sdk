# Contributing

## Branch Naming

```
feat/your-feature-name
fix/what-you-are-fixing
docs/page-or-section-name
refactor/scope-of-change
test/what-is-being-tested
```

## Commit Message Format

Conventional Commits, one logical change per commit:

```
type(scope): short description in lowercase
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.

## Pull Request Process

1. Fork and branch off `main` using the naming rules above.
2. Run `npm run typecheck` and `npm test` and confirm both pass before opening the PR.
3. Open a PR against `main`, referencing the issue it addresses.
4. Push follow-up changes to the same branch rather than opening a new PR.

## Keeping in Sync with the Contract

This SDK's method signatures and error codes mirror [`fundkeep-contract`](https://github.com/fundkeep-web/fundkeep-contract)'s `src/lib.rs` and `src/errors.rs`. If the contract interface changes, update `src/client.ts` and `src/errors.ts` in the same PR (or a linked one) so the two repos don't drift.
