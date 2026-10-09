/*
 * SecretChat – Encrypted files.
 * Sending: the file is encrypted with the chat key (AES-GCM) and uploaded as "<random>.bin"; name, type, size and
 * the IV travel in the (encrypted) message text as "SCF1:{…}". Discord and people without the key only see random
 * characters and a .bin file.
 * Receiving: the interceptor takes the .bin out of the message and remembers it; the accessory below the message
 * downloads it (page fetch, or the main process if CORS blocks it), decrypts it and shows the image / video / audio,
 * or a card with a download button.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { openImageModal } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import { PluginNative } from "@utils/types";
import { Channel, Message } from "@vencord/discord-types";
import { Constants, RestAPI, showToast, SnowflakeUtils, useEffect, UserStore, useState } from "@webpack/common";

import { askGofile, attachmentOf, formatBytes, sendFiles as sendPlainFiles, sendViaGofile, uploadLimit, uploadOne } from "../ChatPopout/upload";
import { decryptFile, encryptFile, encryptMessage, randomBytes, toHex } from "./crypto";
import { channelKey, getKeyBytes } from "./store";

const logger = new Logger("SecretChat");
const cl = classNameFactory("vc-secretchat-");

const Native = VencordNative.pluginHelpers.SecretChat as PluginNative<typeof import("./native")>;

/** Start of the decrypted text of a file message */
export const FILE_MARK = "SCF1:";
/** Discord's limit without Nitro – the encrypted file info has to fit into the message text */
const MAX_LENGTH = 2000;

interface Manifest {
    v: 1;
    /** name, MIME type, size of the original */
    n: string;
    t: string;
    s: number;
    iv: string;
    /** image / video size, for the placeholder */
    w?: number;
    h?: number;
}

interface FileInfo {
    manifest: Manifest;
    url: string;
    keyId: string;
}

/** message id → its encrypted file */
const files = new Map<string, FileInfo>();
/** message id → decrypted blob URL (one download per session) */
const loaded = new Map<string, Promise<string>>();

// ---------------------------------------------------------------- Receiving (called from the interceptor)

function parseManifest(text: string): Manifest | null {
    try {
        const m = JSON.parse(text.slice(FILE_MARK.length));
        return m && typeof m.n === "string" && typeof m.iv === "string" && typeof m.t === "string" ? m : null;
    } catch {
        return null;
    }
}

/**
 * The decrypted text is a file message: remember the .bin attachment, take it out of the message (Discord would
 * show it as a download) and return the text to show instead. null = not a file message.
 */
export function takeFile(m: any, plain: string, keyId: string): string | null {
    if (!plain.startsWith(FILE_MARK)) return null;
    const manifest = parseManifest(plain);
    if (!manifest) return null;

    const attachments: any[] = Array.isArray(m.attachments) ? m.attachments : [];
    const bin = attachments.find(a => /\.bin$/i.test(a?.filename ?? ""));
    if (bin?.url) {
        files.set(m.id, { manifest, url: bin.url, keyId });
        m.attachments = attachments.filter(a => a !== bin);
    }
    return "";
}

export const isFileText = (plain: string) => plain.startsWith(FILE_MARK);

// ---------------------------------------------------------------- Sending

function randomName() {
    return toHex(randomBytes(8));
}

function mediaSize(file: File): Promise<{ w?: number; h?: number; }> {
    if (file.type.startsWith("image/")) {
        return createImageBitmap(file).then(b => { const r = { w: b.width, h: b.height }; b.close(); return r; }).catch(() => ({}));
    }
    if (file.type.startsWith("video/")) {
        return new Promise(resolve => {
            const v = document.createElement("video");
            const url = URL.createObjectURL(file);
            const done = (r: { w?: number; h?: number; }) => { URL.revokeObjectURL(url); resolve(r); };
            v.onloadedmetadata = () => done({ w: v.videoWidth, h: v.videoHeight });
            v.onerror = () => done({});
            v.preload = "metadata";
            v.src = url;
        });
    }
    return Promise.resolve({});
}

/**
 * Sends files into an encrypted chat encrypted – one message per file. Chats without a key get the normal upload.
 * Over the upload limit: asks whether it may go to Gofile instead (not encrypted there – only the link is).
 */
export async function sendEncryptedFiles(channel: Channel, list: File[], messageReference?: unknown) {
    const record = channelKey(channel.id);
    const key = record && getKeyBytes(record.id);
    const me = UserStore.getCurrentUser()?.id;
    if (!record || !key || !me) return sendPlainFiles(channel, list, messageReference);

    const limit = uploadLimit();
    for (const file of list) {
        // AES-GCM adds 16 bytes
        if (file.size + 16 > limit) {
            if (await askGofile(file, "Gofile can't encrypt it – the file is readable there, only the link is sent encrypted.")) sendViaGofile(channel, file);
            continue;
        }
        try {
            const { iv, data } = await encryptFile(key, await file.arrayBuffer());
            const manifest: Manifest = { v: 1, n: file.name.slice(0, 120), t: file.type || "application/octet-stream", s: file.size, iv, ...await mediaSize(file) };
            const content = encryptMessage(record.id, key, me, FILE_MARK + JSON.stringify(manifest));
            if (content.length > MAX_LENGTH) throw new Error("File name too long");

            const upload = await uploadOne(new File([data as BlobPart], `${randomName()}.bin`, { type: "application/octet-stream" }), channel.id);
            await RestAPI.post({
                url: Constants.Endpoints.MESSAGES(channel.id),
                body: {
                    channel_id: channel.id,
                    content,
                    nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                    sticker_ids: [],
                    type: 0,
                    attachments: [attachmentOf(upload, 0)],
                    message_reference: messageReference ?? null
                }
            });
            // Only the first file answers the message
            messageReference = undefined;
        } catch (e) {
            logger.error("Sending an encrypted file failed", e);
            showToast(`Couldn't send ${file.name} encrypted`, "failure");
        }
    }
}

// ---------------------------------------------------------------- Showing

async function fetchBytes(url: string): Promise<ArrayBuffer> {
    try {
        const res = await fetch(url);
        if (res.ok) return await res.arrayBuffer();
    } catch { /* CORS – the main process can */ }
    if (!Native?.download) throw new Error("Restart Discord completely once to load encrypted files");
    const bytes = await Native.download(url);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function load(messageId: string, info: FileInfo) {
    let p = loaded.get(messageId);
    if (!p) {
        p = (async () => {
            const key = getKeyBytes(info.keyId);
            if (!key) throw new Error("The key of this file was deleted");
            const plain = await decryptFile(key, info.manifest.iv, await fetchBytes(info.url));
            return URL.createObjectURL(new Blob([plain], { type: info.manifest.t }));
        })();
        p.catch(() => loaded.delete(messageId));
        loaded.set(messageId, p);
    }
    return p;
}

const kindOf = (type: string) => type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type.startsWith("audio/") ? "audio" : "file";

/** Fits the media into 400 × 300 like Discord's attachments */
function box(m: Manifest) {
    if (!m.w || !m.h) return { width: 300, height: 200 };
    const scale = Math.min(1, 400 / m.w, 300 / m.h);
    return { width: Math.round(m.w * scale), height: Math.round(m.h * scale) };
}

const FILE_PATH = "M6 2a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6H6Zm7 1.5L18.5 9H14a1 1 0 0 1-1-1V3.5Z";
const LOCK_PATH = "M6 9V7a6 6 0 1 1 12 0v2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h1Zm2-2a4 4 0 1 1 8 0v2H8V7Z";

export function EncryptedFile({ message }: { message: Message; }) {
    const info = files.get(message.id);
    const kind = info ? kindOf(info.manifest.t) : "file";
    const [url, setUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const start = () => {
        if (!info || busy) return Promise.resolve(null);
        setBusy(true);
        setError(null);
        return load(message.id, info)
            .then(u => { setUrl(u); return u; })
            .catch(e => { logger.error("Loading an encrypted file failed", e); setError(String(e?.message ?? e)); return null; })
            .finally(() => setBusy(false));
    };

    // Pictures, videos and audio load right away, other files on click
    useEffect(() => { if (info && kind !== "file") start(); }, [message.id]);

    if (!info) return null;
    const m = info.manifest;

    const download = async () => {
        const u = url ?? await start();
        if (!u) return;
        const a = document.createElement("a");
        a.href = u;
        a.download = m.n;
        a.click();
    };

    const badge = (
        <span className={cl("file-badge")} title="Encrypted – only people with the key can see it">
            <svg width={10} height={10} viewBox="0 0 24 24" fill="currentColor"><path d={LOCK_PATH} /></svg>
            Encrypted
        </span>
    );

    if (kind !== "file" && !error) {
        const size = box(m);
        return (
            <div className={cl("file")}>
                {!url ? (
                    <div className={cl("file-wait")} style={kind === "audio" ? undefined : size}>
                        {busy ? "Decrypting …" : "Loading …"}
                    </div>
                ) : kind === "image" ? (
                    <img
                        className={cl("file-media")}
                        src={url}
                        alt={m.n}
                        style={size}
                        onClick={() => openImageModal({ url, original: url, width: m.w ?? size.width, height: m.h ?? size.height })}
                    />
                ) : kind === "video" ? (
                    <video className={cl("file-media")} src={url} controls style={size} />
                ) : (
                    <audio className={cl("file-audio")} src={url} controls />
                )}
                {badge}
            </div>
        );
    }

    return (
        <div className={cl("file-card")}>
            <svg className={cl("file-icon")} width={30} height={30} viewBox="0 0 24 24" fill="currentColor"><path d={FILE_PATH} /></svg>
            <div className={cl("file-meta")}>
                <span className={cl("file-name")}>{m.n}</span>
                <span className={cl("file-size")}>{error ? <span className={cl("file-error")}>{error}</span> : formatBytes(m.s)}</span>
            </div>
            {badge}
            <button className={classes(cl("btn"), cl("btn-primary"))} disabled={busy} onClick={error ? () => start() : download}>
                {busy ? "Decrypting …" : error ? "Retry" : "Download"}
            </button>
        </div>
    );
}
