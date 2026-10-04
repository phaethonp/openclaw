---
summary: "Sign people in to a Gateway with their Boostt account through a trusted proxy"
title: "Boostt sign-in"
sidebarTitle: "Boostt sign-in"
read_when:
  - Running a Gateway whose people are Boostt users
  - Setting up the proxy that signs people in against Boostt
  - Understanding where a profile's Boostt identity comes from
---

A Gateway can admit people by their Boostt account the way it admits them by a
GitHub-backed sign-in: through [trusted-proxy auth](/gateway/trusted-proxy-auth),
with the proxy doing the sign-in and the Gateway verifying what the proxy says.
The person's profile is created from the verified email and carries a
**verified Boostt identity**, shown on **Settings → Profile → Identity** as the
**Boostt account** row and projected on the profile as `boosttIdentity`.

This is a sign-in identity. The credential Boostt tools use is a separate
[Boostt account connection](/gateway/boostt-account) the profile holds.

## How the pieces fit

```text
browser  ->  proxy (signs in against Boostt)  ->  Gateway in trusted-proxy mode
```

1. The proxy signs the person in against Boostt (`POST /api/v1/auth/sign_in`) and
   keeps the session.
2. On every request it forwards two headers: the person's email in the configured
   `userHeader`, and the person's Boostt access token in the configured
   `boostt.assertionHeader`. Client-supplied copies of both are dropped.
3. The Gateway admits the connection by the trusted-proxy rules, then asks Boostt
   whose token it is (`GET /api/v1/auth/me`). Boostt must name the same email the
   proxy did. Only then is the identity recorded.
4. The profile is found or created by the verified email and receives the identity
   row `boostt` / `<user id>`. An empty display name takes the person's Boostt name.

The Gateway never trusts the assertion header alone, and never trusts the user header
for the Boostt identity: the identity provider is asked, every time, as it is for a
Cloudflare Access assertion.

## Configuration

```json5
{
  gateway: {
    bind: "loopback",
    publicOrigin: "https://<this gateway's public name>",
    trustedProxies: ["<the proxy's address>"],
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host", "x-boostt-assertion"],
        boostt: {
          apiUrl: "https://api.boostt.org",
          assertionHeader: "x-boostt-assertion",
        },
      },
    },
  },
}
```

| Key                                                | Meaning                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `gateway.auth.trustedProxy.boostt.apiUrl`          | Boostt API origin the Gateway asks whose token it is. No path, no trailing slash.          |
| `gateway.auth.trustedProxy.boostt.assertionHeader` | Header the proxy sets with the person's Boostt access token. List it in `requiredHeaders`. |

Trusted-proxy and token auth are mutually exclusive: a Gateway that signs people in
runs without `OPENCLAW_GATEWAY_TOKEN`. Every rule on the [trusted-proxy auth](/gateway/trusted-proxy-auth)
page applies: the proxy must be the only path to the Gateway, it must overwrite
`X-Forwarded-For` with a non-loopback client address, and loopback proxies need
`allowLoopback`.

## What a sign-in leaves on the profile

- an email alias, from the user header
- the identity row `boostt` / `<user id>`, with the person's handle
- a display name, when none was set

One Boostt account belongs to one profile: a sign-in from another profile moves the
identity there. One profile holds one Boostt account. The shared owner profile never
receives a sign-in identity; it is the presence for token and password connections.

## Verify

Connect through the proxy, open **Settings → Profile**, and read the **Boostt account**
row under Identity: `@handle` and "Verified from your Boostt sign-in". In the Gateway's
state database, `user_profile_identities` holds `provider = 'boostt'` for the profile.
