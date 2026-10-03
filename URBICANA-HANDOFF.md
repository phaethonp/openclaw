# Urbicana fork: state and method (2026-10-03)

Branch `boostt` carries the product work (`main` is the daily mirror of upstream;
never commit there). Proposal and acceptance: phaethonp/professionals_and_services_db#340.

## Method: brand at the edge

Text is renamed where it leaves the system, never in upstream's files.

| Kind                                                                                                                  | Treatment                                                |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Ours: name constant, theme, marks, identity sentence, mascot and Discord removals                                     | ordinary source changes in files upstream does not touch |
| Upstream's text a person sees or the model reads                                                                      | renamed at the edge (below); source untouched            |
| Upstream's identifiers: `openclaw` command, `~/.openclaw`, `OPENCLAW_*`, package names, types, file names, keys, tags | left exactly as upstream has them                        |

### UI edge: the catalog's door

`ui/src/lib/product-name.ts` holds `PRODUCT_NAME` and `brandText()`. The translation
lookup (`ui/src/i18n/lib/translate.ts`, `t` and `translateActive`) passes every
string through `brandText`, which replaces the exact display form `OpenClaw`
with the product name. Exempt keys live in `BRAND_EXEMPT_KEYS` (today only the
MIT line). Six typed-in labels read `PRODUCT_NAME` directly. Proof:
`ui/src/i18n/brand-door.test.ts` (catalogs still carry upstream's name; nothing
shown does, in all 21 locales).

### Server and model edge: the image build

`scripts/rebrand/rewrite-shipped.mjs --root /app --check` runs in the Dockerfile
build stage after `ui:build`. In built JavaScript it edits only string and
template literals (found by parsing with acorn); in shipped text (templates,
skills, plugin manifests and docs, HTML, web manifest) it edits prose. Only
`\bOpenClaw\b` is replaced. `scripts/rebrand/exceptions.json` lists text kept
as written, with reasons. `--check` fails the build if a display-form
occurrence remains outside the exceptions. The first sentence of the system
prompt is a plain source change: `src/agents/agent-identity-line.ts`.

### Proof per build

1. The build step's `--check` (zero outside exceptions).
2. `ui/src/i18n/brand-door.test.ts`.
3. `pnpm prompt:snapshots:check` (never hand-edit a snapshot; `:gen` then `:check`).
4. One live turn on a cell built from the image: ask what it runs inside.

### Syncing from upstream

Merge `main` into `boostt`. What the 2026-10-03 merge actually needed, in order:

1. Conflicts in our own files resolve by policy (deleted stays deleted; `.i18n/`
   takes theirs). Conflicts in upstream files that we also touched (e.g.
   `ui/src/components/app-sidebar.ts`) are resolved by taking upstream's version
   and removing our deletions again, never by keeping our old hunk.
2. Upstream test fixtures may still name retired protocol fields (`mascot`,
   `critters`, `avatarHat`); strip them (`src/gateway/server-methods/themes.test-support.ts`).
3. `pnpm install --frozen-lockfile` before trusting a typecheck; stale
   `node_modules` after a lockfile merge shows up as type errors in upstream code.
4. Locales: upstream commits only `locales/en.ts` and lets its locale bot
   translate after merge, so a merge brings keys whose translations exist only in
   a later `upstream/main`. The fork has no bot. Import them:
   for each `ui/src/i18n/.i18n/<loc>.meta.json` with `fallbackKeys`, append the
   `upstream/main` `<loc>.tm.jsonl` lines whose `segment_id` is pending (cache
   keys are content-addressed, so they match when the English text is unchanged),
   set `fallbackKeys` to `[]` in the meta (the sync keeps a key flagged while the
   previous meta lists it), then
   `OPENCLAW_CONTROL_UI_I18N_AUTH_OPTIONAL=1 pnpm ui:i18n:sync` and `pnpm ui:i18n:check`.
5. Rebuild; the build step covers whatever text upstream added. If `--check`
   fails, the new text contains the name in a place that needs an exception or a
   decision.

## What is where

- Removals: mascot, pet, lobsterdex, hats, critters, theme-art route, Discord (UI, protocol, server, CLI).
- Theme `urbicana`: works; NOT accepted by phae (built from sampled colours, not phae's theme settings). Redo only after reading the full settings.
- Identity sentence tests pin "running inside Urbicana" (`src/agents/*`, `src/cli/capability-cli.test.ts`).
- The old in-place rename (two sessions, ~3,700 files) was dropped; its tip is kept locally as tag `archive/boostt-ui-2026-10-03` for reference only.

## Local runtime

The host `openclaw` CLI is uninstalled; the fleet's `desktop` cell (upstream image,
127.0.0.1:19102) is the only fleet cell running. The fork image is proven on a
throwaway cell instead:

    docker build -t localhost:5000/urbicana/agent:dev . && scripts/rebrand/proof-cell.sh

`proof-cell.sh` runs `urbicana-proof` on 127.0.0.1:19104 from that image with the
same env and mounts fleet gives a cell, state in `~/.openclaw/fleet/cells/urbicana-proof`
(its `openclaw.json` points at the local bridge provider). Remove it with
`docker rm -f urbicana-proof` when done.

Gateway tokens are never read by the agent; show one with `docker exec -it <cell> openclaw gateway auth-token --show` in a terminal tab.
