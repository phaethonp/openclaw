# Urbicana protocol

Connects the agent to its owner's Urbicana account: the account itself, the owner's Agent Card, and the Boostt marketplace.

## How it works

The plugin exposes an authenticated HTTP route:

```
GET    /plugins/urbicana/account
POST   /plugins/urbicana/account          { access_token }
POST   /plugins/urbicana/account/refresh
DELETE /plugins/urbicana/account
```

`POST` receives the owner's Urbicana access token. The plugin asks Urbicana whose token it is (`GET /api/v1/auth/me`), keeps the owner's user id, email, handle and display name in its own state, and reads the owner's Agent Card (`GET /api/v1/a2a/card`). An agent that already has an owner refuses a second one. `GET` answers who the owner is, never the token. `refresh` reads the card again. `DELETE` forgets the owner.

The card is written to the agent workspace, verbatim, at `urbicana/IDENTITY.md`, where the `bootstrap-extra-files` hook loads it at the start of every session.

The Boostt marketplace is written into the agent's config as the MCP server `boostt` (`mcp.servers.boostt`, Streamable HTTP, `https://geo.boostt.org/marketplace/mcp`), authenticated with the owner's token. The entry is written at sign-in, restored at start, and disabled when the owner is forgotten.

## Configuration

`plugins.entries.urbicana.config`:

- `railsUrl`: the Urbicana API origin as the agent's host reaches it.
- `cardFile`: where the card is written in the workspace; default `urbicana/IDENTITY.md`. The basename must be one the bootstrap hook loads.
- `marketplaceMcpUrl`: the marketplace MCP server's URL; default `https://geo.boostt.org/marketplace/mcp`.

The hook that loads the card must be enabled for that path:

```json5
hooks: { internal: { enabled: true, entries: { "bootstrap-extra-files": { enabled: true, paths: ["urbicana/IDENTITY.md"] } } } }
```
