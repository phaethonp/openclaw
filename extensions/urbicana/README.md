# Urbicana plugin

Connects an OpenClaw Gateway to its owner's Boostt account without changing the Gateway's own code.

What it holds: the owner's Boostt user id, email, handle and display name, and the owner's Boostt access token, in this plugin's own state inside the Gateway's database (`plugin_state_entries`, namespace `owner`). What it writes: the owner's A2A Agent Card, as Boostt holds it, into the agent workspace as a file of its own, `urbicana/IDENTITY.md` by default, loaded by the bundled `bootstrap-extra-files` hook so the model reads it at the start of every session. The document is written verbatim; nothing is rewritten into the Gateway's own templates.

How the owner gets connected: the Urbicana proxy in front of the Gateway hands over the signed-in person's Boostt token with `POST /plugins/urbicana/account {access_token}` after each sign-in. The plugin asks Boostt whose token it is (`GET /api/v1/auth/me`), keeps the owner, and reads the owner's card (`GET /api/v1/a2a/card`). A Gateway that already acts for another Boostt user refuses a second owner.

Routes, under the Gateway's own auth:

- `GET /plugins/urbicana/account`: who the Gateway acts for (never the token).
- `POST /plugins/urbicana/account`: hand over the owner's session.
- `POST /plugins/urbicana/account/refresh`: write the card again from Boostt.
- `DELETE /plugins/urbicana/account`: forget the owner and remove the card file.

Config (`plugins.entries.urbicana.config`): `railsUrl`, the Boostt API origin; `cardFile`, the workspace path of the card, whose basename must be one the hook loads. The Gateway config must enable the hook for that path:

```json5
hooks: { internal: { enabled: true, entries: { "bootstrap-extra-files": { enabled: true, paths: ["urbicana/IDENTITY.md"] } } } }
```

Not done here: the Gateway's own A2A card at `/.well-known/agent-card.json` stays the one the `a2a` extension composes; the owner's card is published to Boostt's registry from the workbench.
