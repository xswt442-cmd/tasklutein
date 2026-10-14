## Summary

Explain the problem, the scope, and the user-visible behavior (or state "internal only").

## Architecture / safety impact

- [ ] The Worker remains a static-asset host and HTTP gateway only
- [ ] FastAPI remains the source of truth for task/report business logic
- [ ] MCP contracts, authentication, and origin-gateway boundaries are preserved
- [ ] No private tokens, database dumps, `.env` files, or personal task records are staged

## Verification

- [ ] `npm run check` (TypeScript, tests, MCP handshake, docs, Worker dry-run)
- [ ] `python -m pytest -q`
- [ ] `ruff check backend/app backend/tests`
- [ ] Any migration or deployment risk is documented

## Documentation and release notes

- [ ] 中文 / English README or relevant guides updated if behavior changed
- [ ] `CHANGELOG.md` Unreleased updated for user-visible changes, or marked N/A
- [ ] Production deploy is **not** assumed when CI passes

## Rollback

Explain how to revert the app change and whether PostgreSQL schema or secrets need special handling.
