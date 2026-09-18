# Bezalel Email agent workflow

Every task moves through the same four beats. Each beat has a skill in
`.claude/skills`, copied from
[michaelshimeles/skills](https://github.com/michaelshimeles/skills); see
[Skill sources](#skill-sources). The repository rules live in `AGENTS.md`
and are imported under [Repository rules](#repository-rules), so edit them
there and keep the workflow here.

## Workflow

1. **Isolate with `/new-feature`.** Every task starts in a fresh Git worktree
   under `.worktrees/` on an `agent/<task>` branch from `origin/main`, so
   agents can work in parallel without conflicts. Never build on `main`.
2. **Build with `/code-structure`.** Write code to the service-layer
   architecture. Actions and boundaries orchestrate the "why/when". A service
   layer owns the reusable "how", with explicit inputs and structured returns.
3. **Prove with `/evidence-driven-testing`.** Verify with the repo's checks
   plus runtime evidence. Capture the before state while reproducing the
   issue, prior to fixing it, and the after state once the change works.
4. **Ship with `/before-and-after`, then `/greploop`.** Open the PR with
   before/after proof in the description. Use a screenshot or video whenever
   the change has a visible surface, and measured numbers or output pairs
   when it does not. Run `/greploop`, or `/greploop-apps` when the PR exceeds
   Greptile's file-count limit, until Greptile reports 5/5 with zero
   unresolved comments. Finish by presenting the PR URL.

Ship-beat notes:

- `/before-and-after` drives the `@vercel/before-and-after` CLI. `--markdown`
  uploads the pair and prints a PR-ready table. It also accepts existing
  PNGs, so evidence gathered while developing can be reused as-is.
- In containers or VMs where Chrome fails with "No usable sandbox", set
  `AGENT_BROWSER_ARGS="--no-sandbox"` for the capture command.
- The default upload host (0x0.st) is public. Dashboard screenshots can show
  inbox addresses and mail, so pass `--upload-url` with a private target for
  anything that does.
- Greptile is installed on this repository and reviews every PR as
  `greptile-apps[bot]`.

## Writing for humans

Run `/unslop` over anything a person will read, before you commit, post, or
send it: commit messages, the PR title and body, README and doc edits, code
comments, and the closing reply. It strips AI tells (em dashes, filler,
hedging, chatbot phrases, puffery, bold-label lists) and replaces fancy
words with plain ones and passive voice with active. Apply it to text you
wrote or changed, not to prose you didn't touch.

## Multi-agent rules

- Never commit directly to `main`.
- One worktree and one branch per task and per agent. Never reuse or modify
  another agent's worktree, branch, or uncommitted work.
- Scope check before starting: skim open PRs' changed files (`gh pr list`,
  `gh pr diff <n> --name-only`) and look for uncommitted work in shared
  checkouts. On overlap, stop and ask for direction.
- Never force-push to `main`, and never plain `--force` anywhere. Use only
  `--force-with-lease`, only on your own task branch.
- Resolve lockfile conflicts by regenerating, never by hand-merging.
- Worktrees don't isolate shared resources. Confirm a dev-server port answers
  your process before trusting it, and don't run schema experiments against a
  shared database.
- If a conflict can't be resolved confidently, stop and report instead of
  guessing.

## Completing a task

1. Keep changes limited to the assigned task.
2. Run the repo's checks: `pnpm build`, `pnpm check`, `pnpm test`, and
   `pnpm source:check`. Add `pnpm test:postgres` when the change touches SQL.
   Use `homelab-job` for full suites when available.
3. Assemble the evidence captured along the way into before/after pairs.
4. Commit with a clear message, rebase onto the latest `origin/main`, and
   rerun the checks.
5. Push (`git push -u origin <branch>`; after rebasing an already-pushed
   branch, `--force-with-lease`).
6. Open the PR. The body must explain what changed, how it was tested (every
   claim backed by evidence), before/after proof, which provider operations
   used test doubles, and any risks or follow-up work. Run the title and body
   through `/unslop` before posting.
7. Run `/greploop` (or `/greploop-apps`) until 5/5 with zero unresolved
   comments.
8. End by presenting the PR URL.

Do not merge the PR unless explicitly instructed. Keep the worktree until
the PR is merged or closed.

## Commands and checks

Use Node.js 24 and pnpm 10.15.1.

| Command | What it does |
| --- | --- |
| `pnpm build` | Builds every package. The Workers bundle with Wrangler dry runs; the dashboard runs its syntax check first |
| `pnpm check` | TypeScript across the workspace, then `pnpm api:check` for API contract drift |
| `pnpm test` | Every package's tests against isolated local databases and PGlite |
| `pnpm test:postgres` | The Worker's PostgreSQL suite; needs `TEST_DATABASE_URL` for a disposable local database |
| `pnpm source:check` | Verifies `SOURCE.json` against the extracted Bezalel files |
| `pnpm api:generate` | Regenerates the OpenAPI document, SDK types, and CLI and MCP schemas after a contract change |
| `pnpm dev` and `pnpm dev:worker` | Local dashboard, and the local Worker on port 8788 |

`pnpm deploy:worker` and `pnpm deploy:dashboard` deploy to Cloudflare by hand.
CI only runs tests. Deploy the API Worker before the dashboard.

## Repository rules

`AGENTS.md` applies in full. Claude Code inlines it here through the import
below, so the rules exist in one file and cannot drift:

@AGENTS.md

Two additions for production work: schema changes and Worker deploys need
explicit authorization from the owner, and each feature guide under `docs/`
has a rollout section that states the order.

## Environment quick reference

- `apps/email` is the Cloudflare Worker API. It reaches PlanetScale through
  Hyperdrive and uses its own R2 bucket and delivery queues.
  `apps/email-dashboard` is the dashboard Worker, with a Node server for local
  or VPS hosting. `apps/email-gateway` is the SMTP gateway packaged with
  Docker. `packages/` holds the SDK, CLI, MCP server, and Python client.
- Production Workers are `bezalel-email-standalone` (API) and
  `bezalel-email-dashboard`. The native Bezalel Worker `bezalel-email` on Neon
  is a separate deployment with its own profile, `wrangler.native.jsonc`.
- Guides live in `docs/`: accounts, settings, developers, planetscale,
  native deployment, dashboard UX, and verification. Reviewed production SQL
  lives in `ops/email/`.
- Local PostgreSQL runs on port 5434 per `docs/planetscale.md`.
  `apps/email/.env` and `.dev.vars` are gitignored and hold local credentials
  only. No production credentials live in the checkout.
- Ship tooling on the development machine: `before-and-after` and
  `agent-browser` as npm globals, `ffmpeg` with `libx264`, and Python 3.
  Playwright is external; set `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` for
  browser checks.

## Local test infrastructure

- `apps/email/test/dashboard-fixture.ts` serves the dashboard against PGlite
  with test doubles for routing, domain verification, sending, object
  storage, Jev, and the browser Notification API. Set
  `FIXTURE_AUTH_MODE=account` and `FIXTURE_PORT=3194`; the control endpoint
  with captured sign-in codes answers on the next port.
- Browser checks run with
  `node --test apps/email-dashboard/test/browser/<name>.mjs`.
  `DASHBOARD_EVIDENCE_DIR` saves screenshots for PR evidence.
- Every PR states which provider operations used test doubles.

## What cannot be tested locally

- Live email delivery, DNS, Cloudflare routing rules, Hyperdrive, R2,
  queues, and cron execution. Do not present simulated delivery as live mail.
- Production migrations and deploys. Follow the feature's rollout section
  and record the deployed Worker version.

## Skill sources

| Skill | Source |
|---|---|
| `new-feature`, `code-structure`, `evidence-driven-testing` | [michaelshimeles/skills](https://github.com/michaelshimeles/skills) |
| `before-and-after` | michaelshimeles/skills, vendored from [vercel-labs/before-and-after](https://github.com/vercel-labs/before-and-after) (or `npx skills add vercel-labs/before-and-after`) |
| `greploop` | michaelshimeles/skills, vendored from [greptileai/skills](https://github.com/greptileai/skills) |
| `greploop-apps` | michaelshimeles/skills (local variant of greploop for huge PRs; no separate upstream) |
| `unslop` | michaelshimeles/skills, vendored from [cursor/plugins (pstack)](https://github.com/cursor/plugins/tree/main/pstack/skills/unslop); frontmatter edited so agents apply it unprompted, body untouched |
