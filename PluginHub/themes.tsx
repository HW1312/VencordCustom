/*
 * PluginHub – Theme Hub tab: install, update, apply and remove the themes bundled with the plugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings, useSettings } from "@api/Settings";
import { classNameFactory } from "@api/Styles";
import { Switch } from "@components/Switch";
import { classes } from "@utils/misc";
import { PluginNative } from "@utils/types";
import { showToast, useEffect, useState } from "@webpack/common";

import { logger } from "./index";
import catalog from "./themes.json";

const cl = classNameFactory("vc-pluginhub-");
const Native = VencordNative.pluginHelpers.PluginHub as PluginNative<typeof import("./native")>;

export interface HubTheme {
    id: string;
    fileName: string;
    name: string;
    author: string;
    version: string;
    description: string;
    colors: string[];
}

export const hubThemes = catalog as HubTheme[];

const TRASH_PATH = "M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h2v-8h-2Zm4 0v8h-2v-8h2Z";

/** true if version a is newer than b ("1.2.0" > "1.1.9") */
function isNewer(a: string, b: string) {
    const pa = a.split(".").map(n => parseInt(n) || 0);
    const pb = b.split(".").map(n => parseInt(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
    }
    return false;
}

/** Hub themes are full redesigns, so applying one turns the other hub themes off */
function apply(theme: HubTheme) {
    const others = new Set(hubThemes.filter(t => t.id !== theme.id).map(t => t.fileName));
    Settings.enabledThemes = [...Settings.enabledThemes.filter(f => !others.has(f) && f !== theme.fileName), theme.fileName];
}

function unapply(theme: HubTheme) {
    Settings.enabledThemes = Settings.enabledThemes.filter(f => f !== theme.fileName);
}

/** Tiny window mock-up drawn in the theme's own colors */
function Preview({ colors }: { colors: string[]; }) {
    const [bg = "#111", panel = "#1c1c1e", card = "#2c2c2e", accent = "#0a84ff"] = colors;
    return (
        <div className={cl("theme-preview")} style={{ background: bg }}>
            <div className={cl("theme-preview-side")} style={{ background: panel }}>
                <span style={{ background: accent }} />
                <span style={{ background: card }} />
                <span style={{ background: card }} />
            </div>
            <div className={cl("theme-preview-main")}>
                <span style={{ background: card, width: "70%" }} />
                <span style={{ background: card, width: "45%" }} />
                <span style={{ background: card, width: "60%" }} />
                <div className={cl("theme-preview-input")} style={{ background: panel }}>
                    <span style={{ background: accent }} />
                </div>
            </div>
        </div>
    );
}

function ThemeCard({ theme, installedVersion, enabled, refresh }: {
    theme: HubTheme;
    installedVersion: string | undefined;
    enabled: boolean;
    refresh(): void;
}) {
    const [busy, setBusy] = useState(false);
    const installed = installedVersion !== undefined;
    const updatable = installed && isNewer(theme.version, installedVersion || "0");

    async function run(action: () => Promise<void>, failText: string) {
        setBusy(true);
        try {
            await action();
        } catch (e) {
            logger.error(failText, e);
            showToast(failText, "failure");
        } finally {
            setBusy(false);
            refresh();
        }
    }

    const install = () => run(async () => {
        await Native.installTheme(theme.id);
        apply(theme);
        showToast(`${theme.name} ${updatable ? "updated" : "installed and applied"}`, "success");
    }, `Could not install ${theme.name}`);

    const remove = () => run(async () => {
        unapply(theme);
        await Native.removeTheme(theme.id);
        showToast(`${theme.name} removed`, "message");
    }, `Could not remove ${theme.name}`);

    return (
        <div className={classes(cl("theme"), enabled && cl("theme-on"))}>
            <Preview colors={theme.colors} />
            <div className={cl("theme-body")}>
                <div className={cl("row-name")}>
                    <span className={cl("row-title")}>{theme.name}</span>
                    <span className={cl("theme-version")}>v{theme.version}</span>
                </div>
                {theme.author && <div className={cl("theme-author")}>by {theme.author}</div>}
                <div className={cl("row-desc")}>{theme.description}</div>
            </div>
            <div className={cl("theme-actions")}>
                {!installed && (
                    <button className={classes(cl("btn"), cl("btn-brand"))} disabled={busy} onClick={install}>
                        {busy ? "Installing…" : "Install"}
                    </button>
                )}
                {updatable && (
                    <button className={classes(cl("btn"), cl("btn-brand"))} disabled={busy} onClick={install}>
                        {busy ? "Updating…" : `Update to v${theme.version}`}
                    </button>
                )}
                {installed && (
                    <>
                        <label className={cl("theme-toggle")}>
                            <span>{enabled ? "Applied" : "Apply"}</span>
                            <Switch checked={enabled} disabled={busy} onChange={v => v ? apply(theme) : unapply(theme)} />
                        </label>
                        <button className={cl("cog")} title="Remove" disabled={busy} onClick={remove}>
                            <svg viewBox="0 0 24 24" width={18} height={18}><path fill="currentColor" d={TRASH_PATH} /></svg>
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

export function ThemesTab({ query }: { query: string; }) {
    const { enabledThemes } = useSettings(["enabledThemes"]);
    /** fileName → version of every theme in the themes folder */
    const [installed, setInstalled] = useState<Record<string, string> | null>(null);

    const refresh = () => {
        VencordNative.themes.getThemesList()
            .then(list => setInstalled(Object.fromEntries(list.map(t => [t.fileName, t.version ?? ""]))))
            .catch(e => { logger.error("Could not read the themes folder", e); setInstalled({}); });
    };
    useEffect(refresh, []);

    const q = query.trim().toLowerCase();
    const shown = q
        ? hubThemes.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
        : hubThemes;

    return (
        <div className={cl("themes")}>
            <div className={cl("themes-note")}>
                Applying a theme here turns off the other Theme Hub themes. Your own themes stay as they are.
                <button className={cl("link")} onClick={() => VencordNative.themes.openFolder()}>Open themes folder</button>
            </div>
            {installed && shown.map(t => (
                <ThemeCard
                    key={t.id}
                    theme={t}
                    installedVersion={installed[t.fileName]}
                    enabled={enabledThemes.includes(t.fileName)}
                    refresh={refresh}
                />
            ))}
            {installed && !shown.length && <div className={cl("empty")}>No themes found.</div>}
        </div>
    );
}
