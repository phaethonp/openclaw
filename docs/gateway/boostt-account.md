---
summary: "Connect a Gateway profile to a Boostt account from Settings → Profile"
title: "Boostt account"
sidebarTitle: "Boostt account"
read_when:
  - Connecting the Urbicana agent's profile to a Boostt account
  - Wiring Boostt tools to the credential a profile holds
  - Debugging the Boostt OAuth redirect on a cell
---

A **Boostt account** is a personal connection a Gateway profile holds, in the same
shape as [My GitHub](/concepts/user-model#github-connections): a credential stored
for the profile, used by Boostt tools, shown and removed from **Settings → Profile**.
It is not a profile identity. Connecting it changes nothing about who is signed in
to the Gateway, which profile a connection is attached to, or what roles apply.

## How it connects

1. On **Settings → Profile → Boostt account**, choose **Connect Boostt account**.
   The Gateway calls `users.boostt.authorize.start` with the browser's origin,
   registers itself with Boostt as a public OAuth client for
   `<origin>/oauth/boostt/callback`, builds the authorization URL with PKCE
   (S256) and a state value, and records the pending request on the profile.
2. The browser opens Boostt's consent page. Approve the connection there.
3. Boostt redirects the browser to `GET /oauth/boostt/callback?code=…&state=…`
   on the Gateway. The Gateway finds the pending request by its state, exchanges
   the code with the verifier, asks Boostt whose token it is
   (`GET /api/v1/auth/me`), and stores the account and tokens as the profile's
   connection.
4. The Profile page polls `users.boostt.authorize.poll` and shows the account.

**Disconnect** removes the connection. Nothing at Boostt is changed.

## Where it is stored

The connection is one record per profile in the secret store, under identity
scope, named `boostt-connection`. Identity-scope records are not listed by the
secret metadata reads, not exported to exec environments, and not purged by the
expiry sweep. The record holds the Boostt user id, email, name and handle, the
OAuth client id, the access token, the refresh token and its expiry. Tokens are
registered for log redaction when read.

The shared owner profile may hold a Boostt connection, as it may hold My GitHub.
Every device that connects with the gateway token shares it.

## Renewal

Boostt issues tokens with or without an expiry. When an expiring token is within
a minute of expiry and a refresh token exists, the next use renews it with the
`refresh_token` grant. A refused renewal is recorded on the connection and the
Profile page shows **Reconnect required**; connect again to replace it.

## Configuration

| Variable         | Default                  | Meaning                              |
| ---------------- | ------------------------ | ------------------------------------ |
| `BOOSTT_API_URL` | `https://api.boostt.org` | Boostt's API origin and OAuth server |

OAuth endpoints are read from `<BOOSTT_API_URL>/.well-known/oauth-authorization-server`
and fall back to `/oauth/authorize`, `/oauth/token`, `/oauth/register`.

## Gateway methods

| Method                          | Scope           | Purpose                                             |
| ------------------------------- | --------------- | --------------------------------------------------- |
| `users.boostt.status`           | `operator.read` | The profile's connection and any pending request    |
| `users.boostt.authorize.start`  | `operator.read` | Begin a connection; returns the authorize URL       |
| `users.boostt.authorize.poll`   | `operator.read` | `pending`, `success` with the account, or `expired` |
| `users.boostt.authorize.cancel` | `operator.read` | Drop a pending request                              |
| `users.boostt.disconnect`       | `operator.read` | Remove the connection                               |

Each method acts for the profile on the live authenticated connection, never for
a profile named in a parameter.
