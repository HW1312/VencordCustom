/*
 * PluginHub – runs in the Electron main process
 * Writes themes from the Theme Hub into Vencord's themes folder. Vencord's own uploadTheme only works on
 * the web, so the desktop app needs this. Only themes bundled with the plugin (themes-data.json, written by
 * build.mjs) can be installed: the renderer passes an id, never CSS or a path.
 * Installed themes also update themselves from the repo (raw.githubusercontent.com, fixed URL per theme), so a
 * theme fix doesn't need a VoidCord update first.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { THEMES_DIR } from "@main/utils/constants";
import { IpcMainInvokeEvent } from "electron";
import { promises as fs } from "fs";
import { join } from "path";

import themeData from "./themes-data.json";

const catalog = themeData as Record<string, { fileName: string; css: string; }>;

function getTheme(id: unknown) {
    const theme = typeof id === "string" && Object.hasOwn(catalog, id) ? catalog[id] : null;
    if (!theme || !/^[\w.-]+\.theme\.css$/.test(theme.fileName)) throw new Error("Unknown theme");
    return theme;
}

/** Same repo as REPO in build.mjs; Themes/<id>/<fileName> on the main branch */
const RAW = "https://raw.githubusercontent.com/HW1312/VencordCustom/main/Themes";
const MAX_BYTES = 2 * 1024 * 1024;

const headerValue = (css: string, key: string) =>
    new RegExp(String.raw`^\s*\/\*\*[\s\S]*?@${key}[ \t]+([^\r\n]+)`).exec(css)?.[1]?.trim() ?? null;

/** true if version a is newer than b ("1.2.0" > "1.1.9") */
function isNewer(a: string | null, b: string | null) {
    const pa = (a ?? "0").split(".").map(n => parseInt(n) || 0);
    const pb = (b ?? "0").split(".").map(n => parseInt(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
    }
    return false;
}

async function fetchRemote(id: string, fileName: string) {
    const res = await fetch(`${RAW}/${encodeURIComponent(id)}/${encodeURIComponent(fileName)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
    const css = await res.text();
    if (css.length > MAX_BYTES) throw new Error("Theme too large");
    return css;
}

/**
 * Updates an installed theme to the newest version – from the repo, or the one bundled with VoidCord if that's
 * newer (or the repo can't be reached). Not installed (removed by the user) → left alone.
 * Returns the new version, or null if nothing changed.
 */
export async function updateTheme(_: IpcMainInvokeEvent, id: string) {
    const { fileName, css: bundled } = getTheme(id);
    const path = join(THEMES_DIR, fileName);
    let current: string;
    try {
        current = await fs.readFile(path, "utf8");
    } catch {
        return null;
    }

    let best = bundled;
    try {
        const remote = await fetchRemote(id, fileName);
        // Must be the same theme (name in the header) and newer than the bundled one
        if (headerValue(remote, "name") === headerValue(bundled, "name") && isNewer(headerValue(remote, "version"), headerValue(best, "version"))) best = remote;
    } catch { /* offline or GitHub down – the bundled one still counts */ }

    const version = headerValue(best, "version");
    if (!isNewer(version, headerValue(current, "version"))) return null;
    await fs.writeFile(path, best, "utf8");
    return version;
}

/**
 * Writes (or overwrites, for updates) the theme file. Vencord's folder watcher reloads it.
 * Returns the version written. This process keeps the themes it started with: after a VoidCord update and only a
 * reload (Ctrl+R), the page already lists the new version but this still writes the old one until Discord restarts.
 */
export async function installTheme(_: IpcMainInvokeEvent, id: string) {
    const { fileName, css } = getTheme(id);
    await fs.mkdir(THEMES_DIR, { recursive: true });
    await fs.writeFile(join(THEMES_DIR, fileName), css, "utf8");
    return headerValue(css, "version");
}

export async function removeTheme(_: IpcMainInvokeEvent, id: string) {
    const { fileName } = getTheme(id);
    await fs.rm(join(THEMES_DIR, fileName), { force: true });
}
