/*
 * ImageText – Vencord Userplugin
 * Right-click an image → "Copy text from image" / "Show text from image". The text is recognized locally with
 * the OCR engine built into Windows (Windows.Media.Ocr) – no download, no online service.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { copyToClipboard } from "@utils/clipboard";
import { IS_WINDOWS } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Menu, showToast } from "@webpack/common";

import type { OcrResult } from "./native";
import { LanguageList, openTextModal, TEXT_ICON } from "./ui";

const logger = new Logger("ImageText");

/** Missing on Discord web / Vesktop builds without our native part */
export const Native = (VencordNative as any)?.pluginHelpers?.ImageText as PluginNative<typeof import("./native")> | undefined;

/** OcrEngine.MaxImageDimension on every Windows version so far */
const MAX_DIMENSION = 10000;
/** Small images are upscaled before OCR – Windows OCR misses text that is only a few pixels tall */
const UPSCALE_BELOW = 1000;

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    language: {
        type: OptionType.SELECT,
        description: "OCR language. Only languages installed in Windows work (Settings > Time & language > Language) – otherwise your Windows display languages are used.",
        options: [
            { label: "Automatic (Windows languages)", value: "", default: true },
            { label: "English (US)", value: "en-US" },
            { label: "English (UK)", value: "en-GB" },
            { label: "German", value: "de-DE" },
            { label: "French", value: "fr-FR" },
            { label: "Spanish", value: "es-ES" },
            { label: "Italian", value: "it-IT" },
            { label: "Portuguese (Brazil)", value: "pt-BR" },
            { label: "Dutch", value: "nl-NL" },
            { label: "Polish", value: "pl-PL" },
            { label: "Turkish", value: "tr-TR" },
            { label: "Russian", value: "ru-RU" },
            { label: "Japanese", value: "ja-JP" },
            { label: "Korean", value: "ko-KR" },
            { label: "Chinese (Simplified)", value: "zh-Hans-CN" }
        ]
    },
    installedLanguages: {
        type: OptionType.COMPONENT,
        description: "OCR languages installed in Windows",
        component: LanguageList
    },
    joinLines: {
        type: OptionType.BOOLEAN,
        description: "Join the recognized lines into one paragraph instead of keeping the line breaks",
        default: false
    },
    upscaleSmall: {
        type: OptionType.BOOLEAN,
        description: "Upscale small images before recognizing them (finds more small text, slightly slower)",
        default: true
    }
});

// ---------------------------------------------------------------- Image → PNG

/**
 * Discord shows scaled-down previews (media.discordapp.net …?width=…&height=…&format=webp).
 * Dropping the size/format parameters gets the original resolution, which recognizes much better.
 */
export function cleanUrl(url: string) {
    try {
        const u = new URL(url);
        if (/(^|\.)discordapp\.(net|com)$/.test(u.hostname)) {
            for (const p of ["width", "height", "format", "quality"]) u.searchParams.delete(p);
        }
        return u.toString();
    } catch {
        return url;
    }
}

/**
 * Picks a contrasting background for transparent images (stickers, emojis, cut-outs): mostly light text
 * goes on black, everything else on white. Without this, transparent pixels turn black and dark text vanishes.
 */
function pickBackground(bitmap: ImageBitmap) {
    const w = Math.min(bitmap.width, 256), h = Math.min(bitmap.height, 256);
    const probe = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
    if (!probe) return null;
    probe.drawImage(bitmap, 0, 0, w, h);
    const { data } = probe.getImageData(0, 0, w, h);

    let transparent = 0, opaque = 0, light = 0;
    for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a < 250) transparent++;
        if (a > 128) {
            opaque++;
            if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] > 160) light++;
        }
    }
    if (transparent === 0) return null;
    return opaque > 0 && light / opaque > 0.5 ? "#000" : "#fff";
}

/**
 * Fetches the image in the renderer and re-encodes it as PNG. Chromium decodes every format Discord shows
 * (WebP, AVIF, GIF …), while Windows' BitmapDecoder may not – so the main process always gets a plain PNG.
 * Discord's CDN sends CORS headers, so a plain fetch works; if it doesn't, the caller falls back to
 * downloading in the main process.
 */
async function toPng(url: string) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bitmap = await createImageBitmap(await res.blob());

    try {
        const { width, height } = bitmap;
        const longest = Math.max(width, height);
        let scale = 1;
        if (longest > MAX_DIMENSION) scale = MAX_DIMENSION / longest;
        else if (settings.store.upscaleSmall && longest < UPSCALE_BELOW) scale = Math.min(2, MAX_DIMENSION / longest);

        const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("No canvas context");

        const background = pickBackground(bitmap);
        if (background) {
            ctx.fillStyle = background;
            ctx.fillRect(0, 0, w, h);
        }
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, w, h);

        const blob = await canvas.convertToBlob({ type: "image/png" });
        return new Uint8Array(await blob.arrayBuffer());
    } finally {
        bitmap.close();
    }
}

// ---------------------------------------------------------------- OCR

export async function recognize(src: string): Promise<OcrResult> {
    if (!IS_WINDOWS || !Native) return { ok: false, error: "Only available in the Discord desktop app on Windows" };

    const url = cleanUrl(src);
    const language = settings.store.language ?? "";

    let png: Uint8Array | null = null;
    try {
        png = await toPng(url);
    } catch (e) {
        logger.warn("Could not read the image in the renderer, downloading it in the main process instead", e);
    }

    try {
        return png
            ? await Native.recognizeImage(png, language)
            : await Native.recognizeUrl(url, language);
    } catch (e) {
        logger.error("Text recognition failed", e);
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

export const joinText = (lines: string[]) =>
    settings.store.joinLines ? lines.map(l => l.trim()).filter(Boolean).join(" ") : lines.join("\n");

let busy = false;

async function copyText(src: string) {
    if (busy) return;
    busy = true;
    showToast("Reading text from image …", "message");

    try {
        const result = await recognize(src);
        if (!result.ok) {
            showToast(`Could not read text: ${result.error}`, "failure");
            return;
        }

        const lines = result.lines.filter(l => l.trim());
        if (!lines.length) {
            showToast("No text found", "message");
            return;
        }

        await copyToClipboard(joinText(lines));
        showToast(`Copied ${lines.length} ${lines.length === 1 ? "line" : "lines"}`, "success");
    } catch (e) {
        logger.error("Copying text failed", e);
        showToast("Could not copy the text", "failure");
    } finally {
        busy = false;
    }
}

// ---------------------------------------------------------------- Context menus

const TextIcon = () => (
    <svg viewBox="0 0 24 24" width={18} height={18}>
        <path fill="currentColor" d={TEXT_ICON} />
    </svg>
);

function makeItems(src: string) {
    return [
        <Menu.MenuItem
            key="vc-imagetext-copy"
            id="vc-imagetext-copy"
            label="Copy text from image"
            icon={TextIcon}
            action={() => void copyText(src)}
        />,
        <Menu.MenuItem
            key="vc-imagetext-show"
            id="vc-imagetext-show"
            label="Show text from image"
            action={() => openTextModal(src)}
        />
    ];
}

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i;

/** Right-click on an image inside a message (attachments, embeds) */
const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    // imageTextRole is added by our patch below (the data-role of the clicked element). If that patch ever
    // breaks we still show the items for anything that has an image source and doesn't look like a video.
    const role = props?.imageTextRole;
    const src: string | undefined = props?.itemSrc ?? props?.itemHref;
    if (!src) return;
    if (role != null ? role !== "img" : VIDEO_EXT.test(src)) return;

    const group = findGroupChildrenByChildId("copy-link", children) ?? children;
    group.push(...makeItems(src));
};

/** Right-click in Discord's image viewer and other places that use the image context menu */
const imageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props?.src || VIDEO_EXT.test(props.src)) return;

    const group = findGroupChildrenByChildId("copy-native-link", children) ?? children;
    group.push(...makeItems(props.src));
};

export default definePlugin({
    name: "ImageText",
    description: "Right-click an image to copy the text in it. Recognized locally with the Windows OCR engine – nothing is uploaded.",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    settings,

    patches: [
        {
            // Same spot ReverseImageSearch uses: pass the clicked element's data-role to the message context menu,
            // so we only show up for images and not for videos or plain links
            find: "#{intl::MESSAGE_ACTIONS_MENU_LABEL}),shouldHideMediaOptions:",
            replacement: {
                match: /favoriteableType:\i,(?<=(\i)\.getAttribute\("data-type"\).+?)/,
                replace: (m, target) => `${m}imageTextRole:${target}.getAttribute("data-role"),`
            }
        }
    ],

    contextMenus: {
        "message": messageContextMenuPatch,
        "image-context": imageContextMenuPatch
    }
});
