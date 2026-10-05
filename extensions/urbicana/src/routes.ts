/**
 * HTTP surface, under the Gateway's own auth (the proxy's trusted-proxy
 * identity reaches these like any Gateway route):
 *   GET    /plugins/urbicana/account          who the Gateway acts for
 *   POST   /plugins/urbicana/account          {access_token}: the proxy hands over the owner's session
 *   POST   /plugins/urbicana/account/refresh  write the owner's card again from Boostt
 *   DELETE /plugins/urbicana/account          forget the owner and remove the card file
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { UrbicanaService } from "./service.js";

const MAX_BODY = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY) {
      return null;
    }
    chunks.push(buf);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function createUrbicanaRouteHandler(service: UrbicanaService) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rel = url.pathname.replace(/^.*\/plugins\/urbicana/u, "");
    try {
      if (rel === "/account" && req.method === "GET") {
        sendJson(res, 200, await service.status());
        return true;
      }
      if (rel === "/account" && req.method === "POST") {
        const body = await readJson(req);
        const token = typeof body?.access_token === "string" ? body.access_token.trim() : "";
        if (!token) {
          sendJson(res, 422, { error: "access_token is required" });
          return true;
        }
        sendJson(res, 200, await service.connect(token));
        return true;
      }
      if (rel === "/account/refresh" && req.method === "POST") {
        sendJson(res, 200, await service.refresh());
        return true;
      }
      if (rel === "/account" && req.method === "DELETE") {
        sendJson(res, 200, await service.disconnect());
        return true;
      }
    } catch (error) {
      sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
      return true;
    }
    return false;
  };
}
