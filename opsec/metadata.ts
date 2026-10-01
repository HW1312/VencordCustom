/*
 * OpSec – Strip metadata from images & videos before they are uploaded.
 *
 * Works directly on the bytes (lossless, no re-compression):
 *  - JPEG: EXIF (GPS, camera, time), XMP, IPTC/Photoshop, comments, thumbnails, C2PA, appended data
 *          (e.g. "Motion Photos"). Image rotation is preserved.
 *  - PNG:  text chunks, eXIf, timestamps, C2PA
 *  - WebP: EXIF, XMP
 *  - MP4/MOV: user/metadata boxes (GPS, device, software) are overwritten – size & offsets stay the same.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface StripResult {
    file: File;
    /** What was found & removed (for display) */
    found: Set<string>;
}

type Bytes = Uint8Array<ArrayBuffer>;

const ascii = (b: Uint8Array, start: number, len: number) => String.fromCharCode(...b.subarray(start, start + len));

// ---------------------------------------------------------------- Reading EXIF/TIFF

const TIFF_TAGS: Record<number, string> = {
    0x8825: "GPS location",
    0x010F: "Device",
    0x0110: "Device",
    0x0131: "Software",
    0x0132: "Capture time",
    0x9003: "Capture time",
    0x013B: "Author",
    0x8298: "Author",
    0xA430: "Owner",
    0xA431: "Serial number",
    0xA435: "Serial number",
    0x8769: "Camera details"
};

/** Reads rotation + interesting tags from a TIFF block (core of EXIF). */
function parseTiff(b: Uint8Array, t: number, end: number, found: Set<string>): number {
    if (t + 8 > end) return 1;
    const le = b[t] === 0x49 && b[t + 1] === 0x49;
    if (!le && !(b[t] === 0x4D && b[t + 1] === 0x4D)) return 1;

    const u16 = (o: number) => le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
    const u32 = (o: number) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;

    let orientation = 1;
    const readIfd = (ifd: number, depth: number) => {
        if (depth > 2 || ifd + 2 > end) return;
        const n = u16(ifd);
        for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (e + 12 > end) break;
            const tag = u16(e);
            if (tag === 0x0112) orientation = u16(e + 8);
            if (TIFF_TAGS[tag]) found.add(TIFF_TAGS[tag]);
            // Exif sub-directory (capture time, serial numbers …)
            if (tag === 0x8769) readIfd(t + u32(e + 8), depth + 1);
        }
    };
    readIfd(t + u32(t + 4), 0);

    return orientation >= 1 && orientation <= 8 ? orientation : 1;
}

/** Minimal EXIF block containing only the rotation (big endian TIFF) */
function orientationTiff(o: number) {
    return [0x4D, 0x4D, 0x00, 0x2A, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0];
}

// ---------------------------------------------------------------- JPEG

function stripJpeg(b: Bytes, found: Set<string>): BlobPart[] | null {
    const n = b.length;
    const parts: Bytes[] = [b.subarray(0, 2)];
    let orientation = 1;
    let orientationInsertAt = 1;
    let changed = false;
    let eoi = false;
    let i = 2;

    while (i + 1 < n) {
        if (b[i] !== 0xFF) return null;
        const m = b[i + 1];

        if (m === 0xFF) { i++; continue; }
        if (m === 0xD9) { parts.push(b.subarray(i, i + 2)); eoi = true; break; }
        if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { parts.push(b.subarray(i, i + 2)); i += 2; continue; }
        if (i + 4 > n) return null;

        const segEnd = i + 2 + ((b[i + 2] << 8) | b[i + 3]);
        if (segEnd > n) return null;
        const p = i + 4; // Start of payload

        let keep = true;
        if (m === 0xE0) {
            keep = ascii(b, p, 5) === "JFIF\0";
            if (keep) orientationInsertAt = parts.length + 1;
        } else if (m === 0xE1) {
            keep = false;
            if (ascii(b, p, 6) === "Exif\0\0") orientation = parseTiff(b, p + 6, segEnd, found);
            else found.add("XMP data");
        } else if (m === 0xE2) {
            keep = ascii(b, p, 12) === "ICC_PROFILE\0"; // keep color profile, drop MPF thumbnails
        } else if ((m >= 0xE3 && m <= 0xEF && m !== 0xEE) || m === 0xFE) {
            keep = false;
            if (m === 0xED) found.add("IPTC data");
            if (m === 0xFE) found.add("Comment");
        }

        if (keep) parts.push(b.subarray(i, segEnd));
        else changed = true;
        i = segEnd;

        if (m === 0xDA) {
            // Compressed image data up to the next real marker
            let k = i;
            while (k + 1 < n && !(b[k] === 0xFF && b[k + 1] !== 0 && !(b[k + 1] >= 0xD0 && b[k + 1] <= 0xD7))) k++;
            parts.push(b.subarray(i, k));
            i = k;
        }
    }

    if (!eoi) return null;
    if (i + 2 < n) {
        // Data after the end of the image: motion photo videos, embedded secondary images …
        changed = true;
        found.add("Appended data");
    }
    if (!changed) return null;

    if (orientation !== 1) {
        const tiff = orientationTiff(orientation);
        const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
        const len = payload.length + 2;
        parts.splice(orientationInsertAt, 0, new Uint8Array([0xFF, 0xE1, len >> 8, len & 0xFF, ...payload]));
    }
    return parts;
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(data: Uint8Array) {
    let c = 0xFFFFFFFF;
    for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: number[]) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

const PNG_DROP: Record<string, string> = {
    tEXt: "Text metadata",
    zTXt: "Text metadata",
    iTXt: "Text metadata",
    eXIf: "EXIF",
    tIME: "Timestamp",
    caBX: "Content Credentials (C2PA)"
};

function stripPng(b: Bytes, found: Set<string>): BlobPart[] | null {
    const parts: Bytes[] = [b.subarray(0, 8)];
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let changed = false;
    let i = 8;

    while (i + 12 <= b.length) {
        const len = dv.getUint32(i);
        const type = ascii(b, i + 4, 4);
        const end = i + 12 + len;
        if (end > b.length) return null;

        if (PNG_DROP[type]) {
            changed = true;
            found.add(PNG_DROP[type]);
            if (type === "eXIf") {
                const o = parseTiff(b, i + 8, i + 8 + len, found);
                if (o !== 1) parts.push(pngChunk("eXIf", orientationTiff(o)));
            }
        } else {
            parts.push(b.subarray(i, end));
        }

        i = end;
        if (type === "IEND") break;
    }

    if (i < b.length) {
        changed = true;
        found.add("Appended data");
    }
    return changed ? parts : null;
}

// ---------------------------------------------------------------- WebP

function stripWebp(b: Bytes, found: Set<string>): BlobPart[] | null {
    const chunks: Bytes[] = [];
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let changed = false;
    let i = 12;

    while (i + 8 <= b.length) {
        const fourcc = ascii(b, i, 4);
        const size = dv.getUint32(i + 4, true);
        const end = Math.min(i + 8 + size + (size & 1), b.length);

        if (fourcc === "EXIF" || fourcc === "XMP ") {
            changed = true;
            if (fourcc === "EXIF") {
                const t = ascii(b, i + 8, 6) === "Exif\0\0" ? i + 14 : i + 8;
                parseTiff(b, t, i + 8 + size, found);
                found.add("EXIF");
            } else found.add("XMP data");
        } else if (fourcc === "VP8X") {
            const copy = b.slice(i, end);
            copy[8] &= ~(0x08 | 0x04); // Clear the "has EXIF" / "has XMP" flags
            chunks.push(copy);
        } else {
            chunks.push(b.subarray(i, end));
        }
        i = end;
    }
    if (!changed) return null;

    const total = 12 + chunks.reduce((s, c) => s + c.length, 0);
    const header = b.slice(0, 12);
    new DataView(header.buffer).setUint32(4, total - 8, true);
    return [header, ...chunks];
}

// ---------------------------------------------------------------- MP4 / MOV

const XMP_UUID = "be7acfcb97a942e89c71999491e3afac";
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");

interface Box { type: string; start: number; size: number; header: number; }

function parseBoxes(dv: DataView, start: number, end: number, base = 0): Box[] | null {
    const boxes: Box[] = [];
    let i = start;
    while (i + 8 <= end) {
        let size = dv.getUint32(i);
        const type = String.fromCharCode(dv.getUint8(i + 4), dv.getUint8(i + 5), dv.getUint8(i + 6), dv.getUint8(i + 7));
        let header = 8;
        if (size === 1) {
            if (i + 16 > end) return null;
            size = dv.getUint32(i + 8) * 2 ** 32 + dv.getUint32(i + 12);
            header = 16;
        } else if (size === 0) {
            size = end - i;
        }
        if (size < header) return null;
        boxes.push({ type, start: base + i, size, header });
        i += size;
    }
    return boxes;
}

async function readBytes(file: Blob, start: number, len: number) {
    return new Uint8Array(await file.slice(start, start + len).arrayBuffer()) as Bytes;
}

/** Blank out a box: type -> "free", content -> zeros. Size stays the same so all offsets remain valid. */
function blankBox(buf: Bytes, offset: number, box: Box) {
    buf.set([0x66, 0x72, 0x65, 0x65], offset + 4);
    buf.fill(0, offset + box.header, offset + box.size);
}

async function stripMp4(file: File, found: Set<string>): Promise<BlobPart[] | null> {
    // Read top-level boxes one by one (videos can be large – never load everything into RAM)
    const top: Box[] = [];
    for (let i = 0; i + 8 <= file.size;) {
        const h = await readBytes(file, i, 16);
        const dv = new DataView(h.buffer);
        let size = dv.getUint32(0);
        const type = ascii(h, 4, 4);
        let header = 8;
        if (size === 1) { size = dv.getUint32(8) * 2 ** 32 + dv.getUint32(12); header = 16; }
        else if (size === 0) size = file.size - i;
        if (size < header || !/^[\x20-\x7e©]{4}$/.test(type)) return null;
        top.push({ type, start: i, size, header });
        i += size;
    }
    if (top[0]?.type !== "ftyp") return null;

    const replacements: { start: number; bytes: Bytes; }[] = [];

    for (const box of top) {
        if (box.type === "uuid") {
            const id = await readBytes(file, box.start + box.header, 16);
            if (hex(id) === XMP_UUID) {
                // XMP can be large, but is usually only a few KB
                if (box.size > 16 * 1024 * 1024) continue;
                const buf = await readBytes(file, box.start, box.size);
                blankBox(buf, 0, box);
                replacements.push({ start: box.start, bytes: buf });
                found.add("XMP data");
            }
        } else if (box.type === "moov" || box.type === "meta") {
            if (box.size > 64 * 1024 * 1024) continue;
            const buf = await readBytes(file, box.start, box.size);
            const dv = new DataView(buf.buffer);
            let changed = false;

            const text = new TextDecoder("latin1").decode(buf);
            if (text.includes("\xA9xyz") || text.includes("location.ISO6709") || text.includes("\xA9loc")) found.add("GPS location");
            if (text.includes("\xA9mak") || text.includes("\xA9mod") || text.includes("quicktime.make") || text.includes("quicktime.model")) found.add("Device");
            if (text.includes("\xA9swr") || text.includes("quicktime.software")) found.add("Software");

            if (box.type === "meta") {
                blankBox(buf, 0, box);
                changed = true;
            } else {
                const walk = (start: number, end: number, depth: number) => {
                    for (const child of parseBoxes(dv, start, end) ?? []) {
                        if (child.type === "udta" || child.type === "meta") {
                            blankBox(buf, child.start, child);
                            changed = true;
                        } else if (child.type === "uuid" && hex(buf.subarray(child.start + child.header, child.start + child.header + 16)) === XMP_UUID) {
                            blankBox(buf, child.start, child);
                            changed = true;
                            found.add("XMP data");
                        } else if (child.type === "trak" && depth === 0) {
                            walk(child.start + child.header, child.start + child.size, depth + 1);
                        }
                    }
                };
                walk(box.header, box.size, 0);
            }

            if (changed) {
                replacements.push({ start: box.start, bytes: buf });
                found.add("Video metadata");
            }
        }
    }

    if (!replacements.length) return null;

    const parts: BlobPart[] = [];
    let pos = 0;
    for (const r of replacements.sort((a, b) => a.start - b.start)) {
        if (r.start > pos) parts.push(file.slice(pos, r.start));
        parts.push(r.bytes);
        pos = r.start + r.bytes.length;
    }
    if (pos < file.size) parts.push(file.slice(pos));
    return parts;
}

// ---------------------------------------------------------------- Entry point

const MAX_IMAGE_SIZE = 100 * 1024 * 1024;

/** Strips metadata. Returns null if the file type is unsupported or there was nothing to remove. */
export async function stripMetadata(file: File, name = file.name): Promise<StripResult | null> {
    const head = await readBytes(file, 0, 12);
    const found = new Set<string>();
    let parts: BlobPart[] | null = null;

    const isJpeg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
    const isPng = head[0] === 0x89 && ascii(head, 1, 3) === "PNG";
    const isWebp = ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP";
    const isMp4 = ascii(head, 4, 4) === "ftyp";

    if ((isJpeg || isPng || isWebp) && file.size <= MAX_IMAGE_SIZE) {
        const b = new Uint8Array(await file.arrayBuffer());
        parts = isJpeg ? stripJpeg(b, found) : isPng ? stripPng(b, found) : stripWebp(b, found);
    } else if (isMp4) {
        parts = await stripMp4(file, found);
    }

    if (!parts) return null;
    return {
        file: new File(parts, name, { type: file.type, lastModified: 0 }),
        found
    };
}

const MEDIA_EXT = /\.(jpe?g|jfif|png|apng|gif|webp|avif|heic|heif|bmp|tiff?|mp4|m4v|mov|webm|mkv|avi|mp3|m4a|ogg|opus|wav|flac|aac)$/i;

export function isMediaFile(name: string, mime = "") {
    return /^(image|video|audio)\//.test(mime) || MEDIA_EXT.test(name);
}

/** Random filename, extension is kept (lowercased) */
export function randomFilename(name: string) {
    const ext = /\.[a-z0-9]{1,5}$/i.exec(name)?.[0].toLowerCase() ?? "";
    const chars = "abcdefghijkmnpqrstuvwxyz23456789";
    const rand = crypto.getRandomValues(new Uint8Array(10));
    return Array.from(rand, x => chars[x % chars.length]).join("") + ext;
}
