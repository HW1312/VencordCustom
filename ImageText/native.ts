/*
 * ImageText – runs in the Electron main process
 * Text recognition uses the OCR engine built into Windows (Windows.Media.Ocr) – nothing is downloaded and
 * nothing leaves the PC. WinRT types are only reachable from Windows PowerShell 5.1 (pwsh 7 dropped the WinRT
 * projection), so we write the image to a temp file and run a small PowerShell script on it.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "child_process";
import { randomBytes } from "crypto";
import { IpcMainInvokeEvent } from "electron";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export type OcrResult =
    | { ok: true; language: string; lines: string[]; }
    | { ok: false; error: string; };

export interface OcrLanguage {
    tag: string;
    name: string;
}

const TIMEOUT = 20_000;
const MAX_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------- PowerShell script

/**
 * Inputs come in through environment variables (no quoting problems):
 *   VC_OCR_MODE   "languages" → list installed OCR languages, otherwise recognize
 *   VC_OCR_IMAGE  absolute path of the image (PNG / JPG / BMP / GIF / TIFF – whatever BitmapDecoder can read)
 *   VC_OCR_LANG   BCP-47 tag, empty = the user's profile languages
 * Prints exactly one JSON object as UTF-8.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1')
    } | Select-Object -First 1
    function Await($op, [Type]$type) {
        $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
        $null = $task.Wait(-1)
        $task.Result
    }

    if ($env:VC_OCR_MODE -eq 'languages') {
        $langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { @{ tag = $_.LanguageTag; name = $_.DisplayName } })
        ConvertTo-Json -InputObject @{ ok = $true; languages = $langs } -Compress -Depth 4
        exit 0
    }

    $engine = $null
    $want = $env:VC_OCR_LANG
    if ($want -and [Windows.Globalization.Language]::IsWellFormed($want)) {
        $lang = New-Object Windows.Globalization.Language $want
        if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang) }
    }
    if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    if (-not $engine) {
        $en = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Select-Object -First 1
        if ($en) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($en) }
    }
    if (-not $engine) { throw 'No OCR language is installed (Settings > Time & language > Language > add a language with "Optical character recognition").' }

    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:VC_OCR_IMAGE)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
        $w = $decoder.OrientedPixelWidth
        $h = $decoder.OrientedPixelHeight
        if ($w -gt $max -or $h -gt $max) {
            $scale = [Math]::Min($max / $w, $max / $h)
            $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
            $transform.ScaledWidth = [uint32][Math]::Floor($decoder.PixelWidth * $scale)
            $transform.ScaledHeight = [uint32][Math]::Floor($decoder.PixelHeight * $scale)
            $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
            $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
                [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
                [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
                $transform,
                [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
                [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
        } else {
            $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        }
        $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $lines = @($result.Lines | ForEach-Object { $_.Text })
        ConvertTo-Json -InputObject @{ ok = $true; language = $engine.RecognizerLanguage.LanguageTag; lines = $lines } -Compress
    } finally {
        $stream.Dispose()
    }
} catch {
    # Async failures arrive wrapped in AggregateException / MethodInvocationException – report the real cause
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    ConvertTo-Json -InputObject @{ ok = $false; error = $e.Message; hresult = $e.HResult } -Compress
    exit 1
}
`;

/** -EncodedCommand wants the script as UTF-16LE base64 – avoids every command line quoting issue */
const ENCODED = Buffer.from(SCRIPT, "utf16le").toString("base64");

function powershellPath() {
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runScript(env: Record<string, string>) {
    return new Promise<any>(resolve => {
        if (process.platform !== "win32") {
            resolve({ ok: false, error: "Only available on Windows" });
            return;
        }

        execFile(
            powershellPath(),
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED],
            { env: { ...process.env, ...env }, timeout: TIMEOUT, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "buffer" },
            (err, stdout) => {
                // The script prints JSON even when it fails, so look at stdout before the error
                const out = stdout.toString("utf8").trim();
                const json = out.slice(out.indexOf("{"));
                try {
                    if (json.startsWith("{")) {
                        resolve(JSON.parse(json));
                        return;
                    }
                } catch { }

                const killed = (err as any)?.killed || (err as any)?.signal;
                resolve({ ok: false, error: killed ? "Text recognition timed out" : err?.message || out || "Text recognition failed" });
            }
        );
    });
}

function normalize(raw: any): OcrResult {
    if (!raw?.ok) {
        // WINCODEC_ERR_COMPONENTNOTFOUND: no decoder for this format (the message itself is localized)
        if ((raw?.hresult | 0) === (0x88982F50 | 0)) return { ok: false, error: "Unsupported image format" };
        return { ok: false, error: String(raw?.error || "Text recognition failed") };
    }
    // ConvertTo-Json in PowerShell 5.1 can turn single element arrays into plain values
    const lines = raw.lines == null ? [] : Array.isArray(raw.lines) ? raw.lines : [raw.lines];
    return { ok: true, language: String(raw.language ?? ""), lines: lines.map(String) };
}

const validLanguage = (lang: unknown): lang is string => typeof lang === "string" && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,3}$/.test(lang);

async function recognizeFile(path: string, language: unknown) {
    return normalize(await runScript({
        VC_OCR_MODE: "recognize",
        VC_OCR_IMAGE: path,
        VC_OCR_LANG: validLanguage(language) ? language : ""
    }));
}

async function withTempFile(ext: string, write: (path: string) => Promise<void>, language: unknown): Promise<OcrResult> {
    const path = join(tmpdir(), `vc-imagetext-${randomBytes(8).toString("hex")}.${ext}`);
    try {
        await write(path);
        return await recognizeFile(path, language);
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
        await fs.rm(path, { force: true }).catch(() => { });
    }
}

// ---------------------------------------------------------------- Exports

/** Recognizes text in an image the renderer already converted to PNG (the usual path). */
export function recognizeImage(_: IpcMainInvokeEvent, png: Uint8Array, language: string) {
    if (!(png instanceof Uint8Array) || png.length === 0) return Promise.resolve<OcrResult>({ ok: false, error: "Invalid image" });
    if (png.length > MAX_BYTES) return Promise.resolve<OcrResult>({ ok: false, error: "Image is too large" });
    return withTempFile("png", path => fs.writeFile(path, png), language);
}

/**
 * Fallback when the renderer couldn't read the image itself (CORS etc.): download it here – no CORS in Node –
 * and let BitmapDecoder figure out the format. WebP only works if the Windows WebP extension is installed.
 */
export function recognizeUrl(_: IpcMainInvokeEvent, url: string, language: string) {
    let parsed: URL;
    try {
        parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
    } catch {
        return Promise.resolve<OcrResult>({ ok: false, error: "Invalid image URL" });
    }

    return withTempFile("img", async path => {
        // fetch follows redirects on its own
        const res = await fetch(parsed, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            signal: AbortSignal.timeout(TIMEOUT)
        });
        if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
        if (Number(res.headers.get("content-length")) > MAX_BYTES) throw new Error("Image is too large");
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BYTES) throw new Error("Image is too large");
        await fs.writeFile(path, buf);
    }, language);
}

/** OCR languages installed in Windows (Settings > Time & language > Language). */
export async function getLanguages(_: IpcMainInvokeEvent): Promise<OcrLanguage[]> {
    const raw = await runScript({ VC_OCR_MODE: "languages" });
    if (!raw?.ok) return [];
    const list = raw.languages == null ? [] : Array.isArray(raw.languages) ? raw.languages : [raw.languages];
    return list.map((l: any) => ({ tag: String(l.tag), name: String(l.name) }));
}
