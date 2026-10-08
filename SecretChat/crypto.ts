/*
 * SecretChat – Crypto
 * Messages: ChaCha20-Poly1305 (RFC 8439). Written out here because messages must be decrypted synchronously
 * while Discord dispatches them, and WebCrypto is async only.
 * Keys: ECDH P-256 handshake or PBKDF2 password, both hashed with SHA-512 (WebCrypto, async is fine there).
 * No imports, so the file can be tested with plain Node.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// ---------------------------------------------------------------- ChaCha20

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

function quarter(s: Uint32Array, a: number, b: number, c: number, d: number) {
    s[a] += s[b]; s[d] = rotl(s[d] ^ s[a], 16);
    s[c] += s[d]; s[b] = rotl(s[b] ^ s[c], 12);
    s[a] += s[b]; s[d] = rotl(s[d] ^ s[a], 8);
    s[c] += s[d]; s[b] = rotl(s[b] ^ s[c], 7);
}

function chachaBlock(key: Uint8Array, counter: number, nonce: Uint8Array, out: Uint8Array) {
    const kv = new DataView(key.buffer, key.byteOffset, 32);
    const nv = new DataView(nonce.buffer, nonce.byteOffset, 12);
    const init = new Uint32Array(16);
    init[0] = 0x61707865; init[1] = 0x3320646e; init[2] = 0x79622d32; init[3] = 0x6b206574;
    for (let i = 0; i < 8; i++) init[4 + i] = kv.getUint32(i * 4, true);
    init[12] = counter;
    for (let i = 0; i < 3; i++) init[13 + i] = nv.getUint32(i * 4, true);

    const s = init.slice();
    for (let i = 0; i < 10; i++) {
        quarter(s, 0, 4, 8, 12); quarter(s, 1, 5, 9, 13); quarter(s, 2, 6, 10, 14); quarter(s, 3, 7, 11, 15);
        quarter(s, 0, 5, 10, 15); quarter(s, 1, 6, 11, 12); quarter(s, 2, 7, 8, 13); quarter(s, 3, 4, 9, 14);
    }
    const ov = new DataView(out.buffer, out.byteOffset, 64);
    for (let i = 0; i < 16; i++) ov.setUint32(i * 4, (s[i] + init[i]) >>> 0, true);
}

function chachaXor(key: Uint8Array, nonce: Uint8Array, counter: number, data: Uint8Array) {
    const out = new Uint8Array(data.length);
    const block = new Uint8Array(64);
    for (let pos = 0; pos < data.length; pos += 64, counter++) {
        chachaBlock(key, counter, nonce, block);
        const end = Math.min(64, data.length - pos);
        for (let i = 0; i < end; i++) out[pos + i] = data[pos + i] ^ block[i];
    }
    return out;
}

// ---------------------------------------------------------------- Poly1305 (BigInt – messages are small)

const P1305 = (1n << 130n) - 5n;
const CLAMP = 0x0ffffffc0ffffffc0ffffffc0fffffffn;

function leToBig(b: Uint8Array) {
    let n = 0n;
    for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
    return n;
}

function poly1305(oneTimeKey: Uint8Array, msg: Uint8Array) {
    const r = leToBig(oneTimeKey.subarray(0, 16)) & CLAMP;
    const s = leToBig(oneTimeKey.subarray(16, 32));
    let acc = 0n;
    for (let i = 0; i < msg.length; i += 16) {
        const chunk = msg.subarray(i, i + 16);
        acc = ((acc + leToBig(chunk) + (1n << BigInt(8 * chunk.length))) * r) % P1305;
    }
    acc = (acc + s) & ((1n << 128n) - 1n);
    const tag = new Uint8Array(16);
    for (let i = 0; i < 16; i++, acc >>= 8n) tag[i] = Number(acc & 0xffn);
    return tag;
}

function macData(aad: Uint8Array, ct: Uint8Array) {
    const pad = (n: number) => (16 - (n % 16)) % 16;
    const aadEnd = aad.length + pad(aad.length);
    const ctEnd = aadEnd + ct.length + pad(ct.length);
    const buf = new Uint8Array(ctEnd + 16);
    buf.set(aad, 0);
    buf.set(ct, aadEnd);
    const v = new DataView(buf.buffer);
    v.setBigUint64(ctEnd, BigInt(aad.length), true);
    v.setBigUint64(ctEnd + 8, BigInt(ct.length), true);
    return buf;
}

function polyKey(key: Uint8Array, nonce: Uint8Array) {
    const block = new Uint8Array(64);
    chachaBlock(key, 0, nonce, block);
    return block.subarray(0, 32);
}

/** ChaCha20-Poly1305 encrypt → ciphertext with the 16-byte tag appended */
export function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array) {
    const ct = chachaXor(key, nonce, 1, plaintext);
    const out = new Uint8Array(ct.length + 16);
    out.set(ct);
    out.set(poly1305(polyKey(key, nonce), macData(aad, ct)), ct.length);
    return out;
}

/** ChaCha20-Poly1305 decrypt → plaintext, or null if the key is wrong or the message was changed */
export function open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array) {
    if (sealed.length < 16) return null;
    const ct = sealed.subarray(0, sealed.length - 16);
    const tag = poly1305(polyKey(key, nonce), macData(aad, ct));
    let diff = 0;
    for (let i = 0; i < 16; i++) diff |= tag[i] ^ sealed[ct.length + i];
    return diff === 0 ? chachaXor(key, nonce, 1, ct) : null;
}

// ---------------------------------------------------------------- Encoding

export function toB64(bytes: Uint8Array) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64(text: string) {
    const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

export const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map(x => parseInt(x, 16)));

const utf8 = new TextEncoder();
const utf8d = new TextDecoder("utf-8", { fatal: true });
export const encodeText = (s: string) => utf8.encode(s);
export const decodeText = (b: Uint8Array) => utf8d.decode(b);

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

// ---------------------------------------------------------------- Message envelope

/**
 * Sent text: "🔒 SC1.<base64url(keyId 4 | nonce 12 | ciphertext + tag)>"
 * The sender's user id is authenticated (AAD), so nobody can repost your ciphertext under their own name.
 */
export const ENC_PREFIX = "🔒 SC1.";
const ENC_RE = /^🔒 SC1\.([A-Za-z0-9_-]{43,})$/;

const aadFor = (authorId: string) => encodeText(`SC1|${authorId}`);

export function encryptMessage(keyId: string, key: Uint8Array, authorId: string, text: string) {
    const nonce = randomBytes(12);
    const sealed = seal(key, nonce, encodeText(text), aadFor(authorId));
    const out = new Uint8Array(4 + 12 + sealed.length);
    out.set(fromHex(keyId), 0);
    out.set(nonce, 4);
    out.set(sealed, 16);
    return ENC_PREFIX + toB64(out);
}

export interface Envelope {
    keyId: string;
    nonce: Uint8Array;
    sealed: Uint8Array;
}

export function parseMessage(content: string): Envelope | null {
    const m = ENC_RE.exec(content);
    if (!m) return null;
    try {
        const raw = fromB64(m[1]);
        if (raw.length < 4 + 12 + 16) return null;
        return { keyId: toHex(raw.subarray(0, 4)), nonce: raw.subarray(4, 16), sealed: raw.subarray(16) };
    } catch {
        return null;
    }
}

export function decryptEnvelope(env: Envelope, key: Uint8Array, authorId: string) {
    const plain = open(key, env.nonce, env.sealed, aadFor(authorId));
    if (!plain) return null;
    try {
        return decodeText(plain);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------- Keys (async, WebCrypto)

export async function sha512(...parts: (Uint8Array | string)[]) {
    const bytes = parts.map(p => typeof p === "string" ? encodeText(p) : p);
    const buf = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of bytes) { buf.set(b, o); o += b.length; }
    return new Uint8Array(await crypto.subtle.digest("SHA-512", buf));
}

/** Short public id of a key (first 4 bytes of a SHA-512) – sent with every message so the right key is found */
export async function keyIdOf(key: Uint8Array) {
    return toHex((await sha512("SecretChat key id", key)).subarray(0, 4));
}

/** Code both people see for the same key – compare it (call, in person) to rule out a man in the middle */
export async function safetyCode(key: Uint8Array) {
    const h = await sha512("SecretChat safety code", key);
    const n = new DataView(h.buffer).getBigUint64(0) % 1_000_000_000_000n;
    return n.toString().padStart(12, "0").replace(/(\d{4})(?=\d)/g, "$1 ");
}

/** Same password → same key on every PC (fixed salt, so it must be a strong password) */
export async function keyFromPassword(password: string) {
    const base = await crypto.subtle.importKey("raw", encodeText(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-512", salt: encodeText("SecretChat group key v1"), iterations: 310_000 },
        base,
        256
    );
    return new Uint8Array(bits);
}

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export async function newHandshakeKeyPair() {
    const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]) as CryptoKeyPair;
    return {
        publicKey: toB64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
        privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey)
    };
}

/** ECDH secret → SHA-512 together with both user ids → 32-byte chat key */
export async function deriveSharedKey(privateJwk: JsonWebKey, theirPublic: string, userA: string, userB: string) {
    const priv = await crypto.subtle.importKey("jwk", privateJwk, ECDH, false, ["deriveBits"]);
    const pub = await crypto.subtle.importKey("raw", fromB64(theirPublic), ECDH, false, []);
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
    const ids = [userA, userB].sort().join("|");
    return (await sha512("SecretChat private key v1", secret, ids)).subarray(0, 32);
}
