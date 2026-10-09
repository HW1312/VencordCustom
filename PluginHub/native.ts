/*
 * PluginHub – runs in the Electron main process
 * Writes themes from the Theme Hub into Vencord's themes folder. Vencord's own uploadTheme only works on
 * the web, so the desktop app needs this. Only themes bundled with the plugin (themes-data.json, written by
 * build.mjs) can be installed: the renderer passes an id, never CSS or a path.
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

/** Writes (or overwrites, for updates) the theme file. Vencord's folder watcher reloads it. */
export async function installTheme(_: IpcMainInvokeEvent, id: string) {
    const { fileName, css } = getTheme(id);
    await fs.mkdir(THEMES_DIR, { recursive: true });
    await fs.writeFile(join(THEMES_DIR, fileName), css, "utf8");
    return fileName;
}

export async function removeTheme(_: IpcMainInvokeEvent, id: string) {
    const { fileName } = getTheme(id);
    await fs.rm(join(THEMES_DIR, fileName), { force: true });
}
