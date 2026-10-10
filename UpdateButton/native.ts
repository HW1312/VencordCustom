/*
 * UpdateButton – runs in the Electron main process.
 * Finds the newest release without GitHub's API (60 requests per hour without login): the normal page
 * github.com/<repo>/releases/latest redirects to …/releases/tag/<version>, so one request with the redirect
 * not followed tells the version. That page has no such limit, so it can be checked every few minutes.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";
import { request } from "https";

/** Same repo as REPO in build.mjs */
const URL_LATEST = "https://github.com/HW1312/VencordCustom/releases/latest";

export function latestTag(_: IpcMainInvokeEvent): Promise<string | null> {
    return new Promise((resolve, reject) => {
        const req = request(URL_LATEST, { method: "HEAD", headers: { "User-Agent": "VoidCord-Updater" } }, res => {
            res.resume();
            const location = res.headers.location ?? "";
            const tag = /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1];
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && tag) resolve(decodeURIComponent(tag));
            else if (res.statusCode === 404) resolve(null);
            else reject(new Error(`GitHub: HTTP ${res.statusCode}`));
        });
        req.on("error", reject);
        req.setTimeout(15_000, () => req.destroy(new Error("Update check timed out")));
        req.end();
    });
}
