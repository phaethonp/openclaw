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

Merge `main` into `boostt`. Conflicts can only be in our own files. Rebuild; the
build step covers whatever text upstream added. If `--check` fails, the new
text contains the name in a place that needs an exception or a decision.

## What is where

- Removals: mascot, pet, lobsterdex, hats, critters, theme-art route, Discord (UI, protocol, server, CLI).
- Theme `urbicana`: works; NOT accepted by phae (built from sampled colours, not phae's theme settings). Redo only after reading the full settings.
- Identity sentence tests pin "running inside Urbicana" (`src/agents/*`, `src/cli/capability-cli.test.ts`).
- The old in-place rename (two sessions, ~3,700 files) was dropped; its tip is kept locally as tag `archive/boostt-ui-2026-10-03` for reference only.

## Local runtime

Fork cell `urbicana-dev` on 127.0.0.1:19101 (image `localhost:5000/urbicana/agent:dev`, loopback registry `local-registry`). `boostt-first` on 19100 is upstream. Rebuild and redeploy:

    docker build -q -t localhost:5000/urbicana/agent:dev . && docker push -q localhost:5000/urbicana/agent:dev && openclaw fleet upgrade urbicana-dev --image localhost:5000/urbicana/agent:dev

Gateway tokens are never read by the agent; show one with `docker exec -it <cell> openclaw gateway auth-token --show` in a terminal tab.
