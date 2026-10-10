/*
 * SecretChat – Info window of an encrypted file: where it is stored, how it is encrypted, and a check that proves it
 * (downloads exactly what the host has, shows its bytes and randomness, then decrypts it with the chat key).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { copyToClipboard } from "@utils/clipboard";
import { showToast, useState } from "@webpack/common";

import { Button, Note, openWindow, Row, Section, Sheet, State } from "../_ui";
import { formatBytes } from "../ChatPopout/upload";
import { decryptFile, fromB64, toHex } from "./crypto";
import { getKey, getKeyBytes } from "./store";

const cl = classNameFactory("vc-secretchat-");

const LOCK_PATH = "M6 9V7a6 6 0 1 1 12 0v2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h1Zm2-2a4 4 0 1 1 8 0v2H8V7Z";

export interface FileInfoData {
    manifest: { n: string; t: string; s: number; iv: string; };
    url: string;
    keyId: string;
}

/** Bytes a file starts with → what it is. The encrypted file must not start with any of these. */
const SIGNATURES: [number, string, string][] = [
    [0, "4d5a", "Windows program (EXE/DLL)"],
    [0, "25504446", "PDF"],
    [0, "89504e47", "PNG image"],
    [0, "ffd8ff", "JPEG image"],
    [0, "47494638", "GIF image"],
    [0, "504b0304", "ZIP archive (also DOCX, XLSX, APK, JAR)"],
    [0, "52617221", "RAR archive"],
    [0, "377abcaf", "7-Zip archive"],
    [0, "1f8b", "GZIP archive"],
    [0, "52494646", "RIFF (WAV / WEBP / AVI)"],
    [0, "1a45dfa3", "WebM / MKV video"],
    [0, "4f676753", "Ogg audio"],
    [0, "494433", "MP3 audio"],
    [0, "664c6143", "FLAC audio"],
    [4, "66747970", "MP4 / MOV video"],
    [0, "7f454c46", "Linux program (ELF)"]
];

function signatureOf(bytes: Uint8Array) {
    for (const [offset, hex, name] of SIGNATURES) {
        if (toHex(bytes.subarray(offset, offset + hex.length / 2)) === hex) return name;
    }
    return null;
}

/** Shannon entropy in bits per byte: 8.00 = indistinguishable from random noise */
function entropy(bytes: Uint8Array) {
    const counts = new Uint32Array(256);
    for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
    let e = 0;
    for (const c of counts) {
        if (!c) continue;
        const p = c / bytes.length;
        e -= p * Math.log2(p);
    }
    return e;
}

/** Share of printable ASCII characters – text files are close to 100 %, random data about 37 % */
function printable(bytes: Uint8Array) {
    const n = Math.min(bytes.length, 64 * 1024);
    let p = 0;
    for (let i = 0; i < n; i++) if ((bytes[i] >= 32 && bytes[i] < 127) || bytes[i] === 9 || bytes[i] === 10 || bytes[i] === 13) p++;
    return n ? p / n : 0;
}

async function sha256(data: ArrayBuffer) {
    return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

const hexBlock = (bytes: Uint8Array, n = 24) => toHex(bytes.subarray(0, n)).replace(/(..)/g, "$1 ").trim();

interface Proof {
    encSize: number;
    encHead: string;
    encEntropy: number;
    encPrintable: number;
    encSignature: string | null;
    encHash: string;
    plainHead: string;
    plainEntropy: number;
    plainSignature: string | null;
    plainHash: string;
}

async function prove(info: FileInfoData, encrypted: ArrayBuffer): Promise<Proof> {
    const key = getKeyBytes(info.keyId);
    if (!key) throw new Error("The key of this file was deleted");
    const enc = new Uint8Array(encrypted);
    let plain: ArrayBuffer;
    try {
        plain = await decryptFile(key, info.manifest.iv, encrypted);
    } catch {
        throw new Error("Decryption failed – wrong file, or it was changed on the host");
    }
    const dec = new Uint8Array(plain);
    return {
        encSize: enc.length,
        encHead: hexBlock(enc),
        encEntropy: entropy(enc),
        encPrintable: printable(enc),
        encSignature: signatureOf(enc),
        encHash: await sha256(encrypted),
        plainHead: hexBlock(dec),
        plainEntropy: entropy(dec),
        plainSignature: signatureOf(dec),
        plainHash: await sha256(plain)
    };
}

function hostOf(url: string) {
    if (url.startsWith("https://files.catbox.moe/")) return "Catbox (catbox.moe)";
    if (url.startsWith("https://gofile.io/")) return "Gofile (gofile.io)";
    return "Discord (attachment)";
}

const Mono = ({ children }: { children: string; }) => <code className={cl("info-mono")}>{children}</code>;

function FileInfoWindow({ info, close, fetchBytes, pickFile }: {
    info: FileInfoData; close(): void;
    fetchBytes(url: string): Promise<ArrayBuffer>;
    pickFile(): Promise<File | null>;
}) {
    const m = info.manifest;
    const gofile = info.url.startsWith("https://gofile.io/");
    const iv = fromB64(m.iv);
    const keyName = getKey(info.keyId)?.name ?? "deleted key";
    const storedName = gofile ? "random name, ends in .bin" : decodeURIComponent(info.url.split("?")[0].split("/").pop() ?? "");

    const [proof, setProof] = useState<Proof | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const check = async () => {
        setBusy(true);
        setError(null);
        try {
            let bytes: ArrayBuffer;
            if (gofile) {
                const picked = await pickFile();
                if (!picked) return;
                bytes = await picked.arrayBuffer();
            } else {
                bytes = await fetchBytes(info.url);
            }
            setProof(await prove(info, bytes));
        } catch (e: any) {
            setError(String(e?.message ?? e));
        } finally {
            setBusy(false);
        }
    };

    const copy = (text: string) => {
        copyToClipboard(text);
        showToast("Copied", "success");
    };

    return (
        <Sheet
            header={{ title: "Encrypted file", subtitle: m.n, icon: LOCK_PATH, iconColor: "green" }}
            onClose={close}
        >
            <Section
                title="Where it is stored"
                footer="Only the encrypted file is uploaded. Its real name, type and size are inside the encrypted message – the host never sees them."
            >
                <Row title="Host" trailing={hostOf(info.url)} />
                <Row title="Name there" subtitle={<Mono>{storedName}</Mono>} />
                <Row
                    title="Link"
                    subtitle={<Mono>{info.url}</Mono>}
                    trailing={
                        <>
                            <Button small variant="gray" onClick={() => copy(info.url)}>Copy</Button>
                            <Button small variant="gray" onClick={() => VencordNative.native.openExternal(info.url)}>Open</Button>
                        </>
                    }
                />
                <Row title="Size there" trailing={`${formatBytes(m.s + 16)} (${(m.s + 16).toLocaleString()} bytes)`} />
            </Section>

            <Section
                title="How it is encrypted"
                footer="Encrypted on the sender's PC before the upload. Without the key the file is random noise; GCM also detects any change to it."
            >
                <Row title="Method" trailing="AES-256-GCM" />
                <Row title="Key" subtitle={`File key derived with SHA-512 from the chat key “${keyName}”`} trailing={<Mono>{info.keyId}</Mono>} />
                <Row title="IV (nonce)" subtitle={<Mono>{toHex(iv)}</Mono>} />
                <Row title="Original" subtitle={`${m.t || "unknown type"}`} trailing={`${formatBytes(m.s)} (${m.s.toLocaleString()} bytes)`} />
                <Row title="Overhead" trailing="16 bytes (authentication tag)" />
            </Section>

            <Section
                title="Proof"
                right={
                    <Button small color="green" disabled={busy} onClick={check}>
                        {busy ? "Checking …" : gofile ? "Check downloaded .bin" : proof ? "Check again" : "Check now"}
                    </Button>
                }
                footer={gofile
                    ? "Download the .bin from Gofile first (Open), then pick it here. The check compares what is on Gofile with the decrypted file."
                    : "Downloads exactly what the host stores, shows what it looks like, then decrypts it with your key."}
            >
                {error && <Row title={<State tone="bad">{error}</State>} />}
                {!proof && !error && <Row dim title={busy ? <State spinner>Downloading and checking …</State> : "Not checked yet"} />}
                {proof && (
                    <>
                        <Row
                            title="On the host"
                            subtitle={<Mono>{proof.encHead}</Mono>}
                            note={`${proof.encSize.toLocaleString()} bytes · randomness ${proof.encEntropy.toFixed(3)} / 8 bits per byte · ${Math.round(proof.encPrintable * 100)} % readable characters`}
                            align="top"
                        />
                        <Row
                            title="Recognizable file type on the host"
                            trailing={proof.encSignature
                                ? <State tone="bad">{proof.encSignature}</State>
                                : <State tone="ok" check>None – looks like noise</State>}
                        />
                        <Row
                            title="Decrypted with your key"
                            subtitle={<Mono>{proof.plainHead}</Mono>}
                            note={`${proof.plainSignature ?? "No known file signature"} · randomness ${proof.plainEntropy.toFixed(3)} / 8`}
                            align="top"
                        />
                        <Row
                            title="Size"
                            trailing={proof.encSize === m.s + 16
                                ? <State tone="ok" check>Original + 16 bytes, as expected</State>
                                : <State tone="warn">{`${proof.encSize.toLocaleString()} bytes (expected ${(m.s + 16).toLocaleString()})`}</State>}
                        />
                        <Row title="Integrity (GCM tag)" trailing={<State tone="ok" check>Unchanged since sending</State>} />
                        <Row title="SHA-256 on the host" subtitle={<Mono>{proof.encHash}</Mono>} />
                        <Row title="SHA-256 decrypted" subtitle={<Mono>{proof.plainHash}</Mono>} />
                    </>
                )}
            </Section>

            {proof && !proof.encSignature && (
                <Note tone="ok">
                    The host only has random-looking bytes{proof.plainSignature ? ` – the real file is a ${proof.plainSignature}, but nothing on the host shows that` : ""}.
                    Only your key turns it back into the original.
                </Note>
            )}
        </Sheet>
    );
}

export function openFileInfo(info: FileInfoData, fetchBytes: (url: string) => Promise<ArrayBuffer>, pickFile: () => Promise<File | null>) {
    openWindow(close => <FileInfoWindow info={info} close={close} fetchBytes={fetchBytes} pickFile={pickFile} />, { size: "medium" });
}
