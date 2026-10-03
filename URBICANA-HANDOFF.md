# Urbicana fork: handoff (rewritten 2026-10-03)

Branch `boostt-ui`. Uncommitted. Not sent to GitHub. Two sessions have worked in
this tree: the 2026-09-30 session (lobster removal, UI name, theme, the first
identity sentence) and a later session that renamed the product name across the
server and plugins (3,700 changed paths; `urbicana-legacy` markers on lines
kept on purpose). Before editing, check nobody else is: `find src extensions ui/src -mmin -30 -type f`.

## The rule (phae)

Replace one position at a time, prove it does not break, record it. The
replacement follows the written form: OpenClaw→Urbicana, openclaw→urbicana,
OPENCLAW→URBICANA. The MIT line "OpenClaw Foundation" is never touched. Do not
ask phae whether a position is safe; that is a fact in the code. Ask only
product wording, with a proposal.

## The tool: scripts/rebrand

- `rename-map.json`: the map. Every rule has `match`, `action` (replace or keep),
  and `why`; replace rules carry `to`, `paired` (files that must change
  together) and `verified` (the evidence). Keep rules with `"step": "pending"`
  are work not done yet, one kind each.
- `rebrand.mjs inventory`: job 1+2. Finds every occurrence of every form, classifies it
  (text, prose, comment, identifier, package, module-path, env, path, command,
  url, custom-element, css-token, dotted-key, event-name, log-prefix,
  id-literal, tmp-dir, hyphenated-name), matches it to the first fitting rule,
  writes `.artifacts/rebrand-ledger.tsv`. Exits 1 if any occurrence has no rule.
- `rebrand.mjs match [--rule id] [--area prefix]`: list the occurrences under a rule.
- `rebrand.mjs apply --rule id [--area prefix] [--dry-run]`: job 3, changes only
  that rule's occurrences; refuses when a paired file is not covered.
- `rebrand.mjs check`: job 4, inventory again plus the checks listed in the map
  (prompt snapshot). Exits 1 while anything is unmatched or a replace rule is
  still pending on disk.

A step is: pick a pending keep rule (or add a literal rule), decide the
replacement and the paired files, flip it to replace, `apply --rule`, run that
rule's tests, `check`, record `verified`, commit the rule and the change together.
After a sync from upstream: merge, `inventory` (new occurrences show as
unmatched or as pending rules), handle them, `check`.

## Inventory at handoff

```
78634 occurrences in 14702 files
 31290  keep     code-identifier
 22317  keep     package-name
  4852  keep     env-var
  4529  keep     path
  4167  keep     module-path
  2822  keep     command
  1847  keep     hyphenated-name
  1506  keep     dotted-key
  1497  keep     id-literal
  1291  keep     custom-element
   858  keep     url
   547  keep     lowercase-prose
   321  keep     lowercase-comment
   264  keep     tmp-dir
   243  keep     event-name
   181  keep     css-token
    69  keep     log-prefix
    10  replace  display-text-camel
     9  keep     mit-notice
     6  keep     legacy-transcript-marker
     6  keep     uppercase-comment
     1  replace  openclaw-capitalised
     1  keep     macos-bundle-executable
```

The 11 occurrences still under replace rules are display text the later
session missed: the runtime-context header, the plugin-authoring template, a
doctor message, two docker-entrypoint messages, the `openclaw --version`
banner, two test-helper labels, one Codex message, one comment. Apply them with
their tests (`apply --rule display-text-camel`, `apply --rule openclaw-capitalised`).

The large pending kinds (module-path 4,167; hyphenated-name 1,847; dotted-key
1,506; id-literal 1,497; custom-element 1,291; env 4,853; path 4,354; command
2,822; package 22,317) are interfaces: each needs its sides changed together,
and the ones on disk (state dir, settings, stored keys, ids in data) need a
migration. Order them by what a member or the model can see; identifiers last.

## Other state

- Theme `urbicana`: works, NOT accepted by phae. Read phae's full theme settings before touching it.
- 47 UI tests asserted the old UI name on 2026-09-30; unknown whether the later session fixed them.
- Fork source 2026.9.6; cell `boostt-first` (19100) runs upstream 2026.9.7 state, so the fork image cannot take it over until upstream is merged (needs commits).
- Local: cell `urbicana-dev` on 19101 from image `localhost:5000/urbicana/agent:dev` (loopback registry `local-registry`). Rebuild: `docker build -q -t localhost:5000/urbicana/agent:dev . && docker push -q localhost:5000/urbicana/agent:dev && openclaw fleet upgrade urbicana-dev --image localhost:5000/urbicana/agent:dev`.
- Gateway tokens: never read by the agent; show with `docker exec -it <cell> openclaw gateway auth-token --show` in a terminal tab.
