/*
 * GofileUpload – runs in the Electron main process
 * The upload happens here (Node) instead of in Discord's page: no CSP / CORS in the way and no browser
 * request limits. The renderer streams the file in chunks into a temp file, which can then be uploaded to
 * several hosts in a row (Gofile, Catbox as fallback) without copying it again.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomBytes } from "crypto";
import { IpcMainInvokeEvent } from "electron";
import { createReadStream, createWriteStream, promises as fs, WriteStream } from "fs";
import { request } from "https";
import { tmpdir } from "os";
import { join } from "path";

/** Hosts are hardcoded so the renderer can't make us upload anywhere else */
const PROVIDERS = {
    gofile: { host: "upload.gofile.io", path: "/uploadfile", fileField: "file", fields: {} as Record<string, string> },
    catbox: { host: "catbox.moe", path: "/user/api.php", fileField: "fileToUpload", fields: { reqtype: "fileupload" } as Record<string, string> }
};
export type Provider = keyof typeof PROVIDERS;

interface Job {
    path: string;
    out: WriteStream | null;
    sent: number;
    total: number;
    cancel?: () => void;
    cancelled: boolean;
}

const jobs = new Map<string, Job>();

const validId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9]{8,32}$/.test(id);

/** Creates a temp file for the upload. Returns the job id. */
export async function beginUpload(_: IpcMainInvokeEvent) {
    const id = randomBytes(8).toString("hex");
    const path = join(tmpdir(), `vc-gofile-${id}`);
    const out = createWriteStream(path);
    await new Promise<void>((res, rej) => { out.once("open", () => res()); out.once("error", rej); });
    jobs.set(id, { path, out, sent: 0, total: 0, cancelled: false });
    return id;
}

/** Appends a chunk of the file to the temp file. */
export async function writeChunk(_: IpcMainInvokeEvent, id: string, chunk: Uint8Array) {
    const job = validId(id) ? jobs.get(id) : null;
    if (!job?.out || job.cancelled) throw new Error("Upload was cancelled");
    if (!(chunk instanceof Uint8Array)) throw new Error("Invalid chunk");
    const { out } = job;
    await new Promise<void>((res, rej) => out.write(chunk, e => e ? rej(e) : res()));
}

const escapeHeader = (s: string) => s.replace(/[\r\n"]/g, "_");

/**
 * Uploads the temp file to a host as multipart/form-data and resolves with the raw response body.
 * `fields` are extra form fields (Gofile: token + folderId to put several files into one folder).
 * The temp file is kept, so a failed upload can be retried with another host – call discardUpload() at the end.
 */
export async function uploadTo(_: IpcMainInvokeEvent, id: string, provider: Provider, name: string, mime: string, fields?: Record<string, string>) {
    const job = validId(id) ? jobs.get(id) : null;
    const target = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : null;
    if (!job) throw new Error("Unknown upload");
    if (!target) throw new Error("Unknown host");

    if (job.out) {
        const { out } = job;
        job.out = null;
        await new Promise<void>((res, rej) => out.end((e?: Error | null) => e ? rej(e) : res()));
    }
    if (job.cancelled) throw new Error("Cancelled");

    const { size } = await fs.stat(job.path);
    const boundary = "----vcupload" + randomBytes(12).toString("hex");
    const field = (k: string, v: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${escapeHeader(k)}"\r\n\r\n${v}\r\n`;

    let head = "";
    for (const [k, v] of Object.entries({ ...target.fields, ...fields })) head += field(k, String(v));
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${target.fileField}"; filename="${escapeHeader(String(name))}"\r\n`
        + `Content-Type: ${escapeHeader(String(mime || "application/octet-stream"))}\r\n\r\n`;
    const headBuf = Buffer.from(head, "utf8");
    const tailBuf = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    job.sent = 0;
    job.total = size;

    try {
        return await new Promise<string>((resolve, reject) => {
            const req = request({
                host: target.host,
                path: target.path,
                method: "POST",
                headers: {
                    "Content-Type": `multipart/form-data; boundary=${boundary}`,
                    "Content-Length": headBuf.length + size + tailBuf.length,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                }
            }, res => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", c => { if (data.length < 1_000_000) data += c; });
                res.on("end", () => {
                    if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) resolve(data);
                    else reject(new Error(`HTTP ${res.statusCode}: ${data.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 150).trim()}`));
                });
                res.on("error", reject);
            });

            req.on("error", reject);
            job.cancel = () => req.destroy(new Error("Cancelled"));

            req.write(headBuf);
            const file = createReadStream(job.path, { highWaterMark: 1024 * 1024 });
            file.on("data", chunk => { job.sent += chunk.length; });
            file.on("error", e => req.destroy(e));
            file.on("end", () => req.end(tailBuf));
            file.pipe(req, { end: false });
        });
    } finally {
        job.cancel = undefined;
    }
}

/** Bytes of the file sent so far (counts what was handed to the socket). */
export function getProgress(_: IpcMainInvokeEvent, id: string) {
    const job = validId(id) ? jobs.get(id) : null;
    return job ? { sent: job.sent, total: job.total } : null;
}

/** Deletes the temp file. */
export async function discardUpload(_: IpcMainInvokeEvent, id: string) {
    const job = validId(id) ? jobs.get(id) : null;
    if (!job) return;
    jobs.delete(id);
    job.out?.destroy();
    await fs.rm(job.path, { force: true }).catch(() => { });
}

export async function cancelUpload(_: IpcMainInvokeEvent, id: string) {
    const job = validId(id) ? jobs.get(id) : null;
    if (!job) return;
    job.cancelled = true;
    job.cancel?.();
}
