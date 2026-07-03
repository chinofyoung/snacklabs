## Global Constraints

- **NO git commands.** Do not run any state-changing git command (no `git init`, `add`, `commit`, etc.). The user handles version control. Task steps therefore have no commit steps.
- **Anthropic model:** `claude-opus-4-8`, exactly this string, in both Edge Functions. Structured output via `output_config: { format: { type: "json_schema", schema: ... } }`. The API key lives ONLY in Supabase Edge Function secrets (`ANTHROPIC_API_KEY`), never in frontend code or `.env` files that ship to the browser.
- **Currency:** Philippine Pesos. All money displayed via `formatPeso()` from `src/lib/money.ts`. Prices stored as `numeric(10,2)` in Postgres, plain `number` in TS.
- **Auth domain:** only `@goabroad.com` emails may create profiles (enforced by DB trigger).
- **Stock integrity:** the client NEVER writes `items.stock` or `orders.status` directly for purchases. Stock decrement happens only in the `confirm_order` Postgres function; restock only in `apply_restock`.
- **Screenshots:** if any task saves screenshots, save them under `docs/screenshots/` (create the directory if missing), never the project root.
- **Order status flow:** `awaiting_payment → verifying → paid | needs_review | cancelled`. String literals exactly as written.
- Run `npm run test` (Vitest) and `npm run build` (tsc + vite) as the verification gate for every frontend task.

