/*
 * StreamOverlay – runs in the Electron main process
 * Local HTTP server (127.0.0.1 only) for the OBS browser source: overlay page, live data via SSE, JSON snapshot.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";

import { buildOverlayHtml } from "./overlay";

const HOST = "127.0.0.1";
const HEARTBEAT_MS = 15_000;

let server: Server | null = null;
let port = 0;
let lastError: string | null = null;
let stateJson = "{}";
let heartbeat: ReturnType<typeof setInterval> | undefined;
let html: string | null = null;

const clients = new Set<ServerResponse>();

export interface ServerStatus {
    running: boolean;
    port: number;
    clients: number;
    error: string | null;
}

// ---------------------------------------------------------------- Requests

const CSP = [
    "default-src 'none'",
    "img-src https://cdn.discordapp.com https://media.discordapp.net data:",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "connect-src 'self'"
].join("; ");

function send(res: ServerResponse, status: number, type: string, body: string) {
    res.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    res.end(body);
}

function handle(req: IncomingMessage, res: ServerResponse) {
    // Protection against DNS rebinding: only accept requests via 127.0.0.1 / localhost
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) return send(res, 403, "text/plain; charset=utf-8", "Forbidden");
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain; charset=utf-8", "Method not allowed");

    const path = new URL(req.url ?? "/", `http://${HOST}`).pathname;

    switch (path) {
        case "/":
        case "/index.html":
            html ??= buildOverlayHtml();
            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Content-Security-Policy": CSP,
                "X-Content-Type-Options": "nosniff"
            });
            return res.end(html);

        case "/state":
            return send(res, 200, "application/json; charset=utf-8", stateJson);

        case "/events": {
            res.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-store",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            });
            res.write(`retry: 2000\n\ndata: ${stateJson}\n\n`);
            clients.add(res);
            req.socket.setKeepAlive(true);
            req.socket.setNoDelay(true);
            const drop = () => clients.delete(res);
            req.on("close", drop);
            res.on("error", drop);
            return;
        }

        case "/favicon.ico":
            res.writeHead(204);
            return res.end();

        default:
            return send(res, 404, "text/plain; charset=utf-8", "Not found");
    }
}

function broadcast(chunk: string) {
    for (const res of clients) {
        try {
            res.write(chunk);
        } catch {
            clients.delete(res);
        }
    }
}

// ---------------------------------------------------------------- Start / Stop

function describeError(err: NodeJS.ErrnoException, p: number) {
    switch (err.code) {
        case "EADDRINUSE": return `Port ${p} is already in use (another program?). Choose a different port.`;
        case "EACCES": return `No permission for port ${p}. Choose a port above 1024.`;
        default: return `Server could not start: ${err.message}`;
    }
}

function getStatus(): ServerStatus {
    return { running: server != null, port, clients: clients.size, error: lastError };
}

export async function startServer(_: IpcMainInvokeEvent, wantedPort: number): Promise<ServerStatus> {
    if (!Number.isInteger(wantedPort) || wantedPort < 1024 || wantedPort > 65535) {
        lastError = "Invalid port – allowed range is 1024 to 65535.";
        return getStatus();
    }
    if (server && port === wantedPort) return getStatus();
    if (server) await stopServer(_);

    lastError = null;
    html = null; // regenerate after plugin updates

    const srv = createServer(handle);
    srv.keepAliveTimeout = 5_000;

    await new Promise<void>(resolve => {
        srv.once("error", (err: NodeJS.ErrnoException) => {
            lastError = describeError(err, wantedPort);
            resolve();
        });
        srv.listen(wantedPort, HOST, () => {
            server = srv;
            port = wantedPort;
            resolve();
        });
    });

    if (server !== srv) return getStatus();

    srv.on("error", err => console.error("[StreamOverlay] Server error", err));
    heartbeat = setInterval(() => broadcast(": ping\n\n"), HEARTBEAT_MS);
    console.log(`[StreamOverlay] Server running on http://${HOST}:${port}`);
    return getStatus();
}

export async function stopServer(_?: IpcMainInvokeEvent): Promise<ServerStatus> {
    clearInterval(heartbeat);
    heartbeat = undefined;

    for (const res of clients) {
        try { res.end(); } catch { }
    }
    clients.clear();

    const srv = server;
    server = null;
    port = 0;
    lastError = null;

    if (srv) {
        await new Promise<void>(resolve => {
            srv.close(() => resolve());
            srv.closeAllConnections?.();
        });
    }
    return getStatus();
}

export function serverStatus(_: IpcMainInvokeEvent): ServerStatus {
    return getStatus();
}

// ---------------------------------------------------------------- Data

/** New state from the renderer – immediately to all OBS sources */
export function pushState(_: IpcMainInvokeEvent, json: string) {
    if (typeof json !== "string") return;
    stateJson = json;
    if (clients.size) broadcast(`data: ${json}\n\n`);
}
