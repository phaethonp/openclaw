import { escapeHtml } from "./html-escape.js";

// Static product mark; keep shapes in sync with ui/public/favicon.svg.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none" aria-hidden="true"><rect x="8" y="8" width="104" height="104" rx="28" fill="#111111"/><path d="M40 42L62 60L40 78M68 80H88" fill="none" stroke="#ffffff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Callback transports admit exactly these bytes through their stylesheet CSP hash.
export const OAUTH_PAGE_STYLES = `
    :root {
      color-scheme: light dark;
      --text: #191b20;
      --text-dim: #60646d;
      --page-bg: #f5f6f8;
      --surface: #ffffff;
      --detail-bg: #f1f2f5;
      --shadow: 0 16px 52px rgb(24 30 42 / 0.07);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-synthesis: none;
      -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --text: #f2f3f5;
        --text-dim: #a9afb9;
        --page-bg: #0f1012;
        --surface: #181a1e;
        --detail-bg: #22252a;
        --shadow: 0 16px 52px rgb(0 0 0 / 0.18);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100svh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      text-align: center;
    }
    main {
      width: min(100%, 480px);
      padding: clamp(28px, 6vw, 44px) clamp(24px, 5vw, 40px);
      border-radius: 24px;
      background: var(--surface);
      box-shadow: var(--shadow);
      overflow-wrap: anywhere;
    }
    .logo {
      width: 56px;
      height: 56px;
      margin: 0 auto 24px;
    }
    .logo svg { display: block; width: 100%; height: 100%; }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(23px, 5vw, 28px);
      line-height: 1.2;
      font-weight: 650;
      letter-spacing: -0.035em;
      text-wrap: balance;
    }
    p {
      margin: 0;
      color: var(--text-dim);
      font-size: 15px;
      line-height: 1.65;
    }
    .details {
      margin-top: 24px;
      padding: 14px 16px;
      border-radius: 12px;
      background: var(--detail-bg);
      color: var(--text-dim);
      font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      text-align: left;
      white-space: pre-wrap;
    }
`;

export function renderOAuthPage(options: {
  title: string;
  heading: string;
  message: string;
  details?: string;
}): string {
  const title = escapeHtml(options.title);
  const heading = escapeHtml(options.heading);
  const message = escapeHtml(options.message);
  const details = options.details ? escapeHtml(options.details) : undefined;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>${title}</title>
  <style>${OAUTH_PAGE_STYLES}</style>
</head>
<body>
  <main>
    <div class="logo">${LOGO_SVG}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

/** Renders the local OAuth callback success page after provider authentication completes. */
export function oauthSuccessHtml(message: string): string {
  return renderOAuthPage({
    title: "Authentication successful",
    heading: "Authentication successful",
    message,
  });
}

/** Renders the local OAuth callback error page without exposing raw credential material. */
export function oauthErrorHtml(message: string, details?: string): string {
  return renderOAuthPage({
    title: "Authentication failed",
    heading: "Authentication failed",
    message,
    details,
  });
}
