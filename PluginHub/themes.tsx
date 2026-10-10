/*
 * PluginHub – Theme Hub tab: install, update, apply and remove the themes bundled with the plugin.
 * Installed themes also update themselves from the repo (index.tsx → native.ts updateTheme); the button checks now.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings, useSettings } from "@api/Settings";
import { PluginNative } from "@utils/types";
import { showToast, useEffect, useState } from "@webpack/common";

import { Badge, Button, Empty, Group, IconButton, ICONS, Note, Row, Section, Spinner, Toggle } from "../_ui";
import { logger, updateThemes } from "./index";
import catalog from "./themes.json";

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
        <div className="vc-pluginhub-preview" style={{ background: bg }}>
            <div className="vc-pluginhub-preview-side" style={{ background: panel }}>
                <span style={{ background: accent }} />
                <span style={{ background: card }} />
                <span style={{ background: card }} />
            </div>
            <div className="vc-pluginhub-preview-main">
                <span style={{ background: card, width: "70%" }} />
                <span style={{ background: card, width: "45%" }} />
                <span style={{ background: card, width: "60%" }} />
                <div className="vc-pluginhub-preview-input" style={{ background: panel }}>
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
        const written = await Native.installTheme(theme.id);
        apply(theme);
        if (written && isNewer(theme.version, written))
            showToast(`Quit Discord completely (tray icon → Quit) and start it again to finish updating ${theme.name}`, "message");
        else
            showToast(`${theme.name} ${updatable ? "updated" : "installed and applied"}`, "success");
    }, `Could not install ${theme.name}`);

    const remove = () => run(async () => {
        unapply(theme);
        await Native.removeTheme(theme.id);
        showToast(`${theme.name} removed`, "message");
    }, `Could not remove ${theme.name}`);

    return (
        <Group>
            <Row
                align="top"
                leading={<Preview colors={theme.colors} />}
                title={<span className="vc-pluginhub-name">{theme.name}<Badge>v{theme.version}</Badge></span>}
                subtitle={theme.author && `by ${theme.author}`}
                note={theme.description}
                trailing={
                    <>
                        {!installed && (
                            <Button small disabled={busy} onClick={install}>{busy ? "Installing…" : "Install"}</Button>
                        )}
                        {updatable && (
                            <Button small disabled={busy} onClick={install}>{busy ? "Updating…" : `Update to v${theme.version}`}</Button>
                        )}
                        {installed && (
                            <>
                                <span className="vc-pluginhub-apply">{enabled ? "Applied" : "Apply"}</span>
                                <Toggle checked={enabled} disabled={busy} label="Apply" onChange={v => v ? apply(theme) : unapply(theme)} />
                                <IconButton icon={ICONS.trash} label="Remove" destructive disabled={busy} onClick={remove} />
                            </>
                        )}
                    </>
                }
            />
        </Group>
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

    const [checking, setChecking] = useState(false);
    const checkUpdates = async () => {
        setChecking(true);
        try {
            const updated = await updateThemes();
            if (!updated) showToast("All themes are up to date", "message");
        } finally {
            setChecking(false);
            refresh();
        }
    };

    const q = query.trim().toLowerCase();
    const shown = q
        ? hubThemes.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
        : hubThemes;

    return (
        <>
            <Note>
                <span className="vc-pluginhub-restart">
                    <span>Applying a theme here turns off the other Theme Hub themes. Your own themes stay as they are.</span>
                    <Button variant="plain" small icon={checking ? undefined : ICONS.refresh} disabled={checking} onClick={checkUpdates}>
                        {checking && <Spinner />}{checking ? "Checking …" : "Check for theme updates"}
                    </Button>
                    <Button variant="plain" small icon={ICONS.folder} onClick={() => VencordNative.themes.openFolder()}>Open themes folder</Button>
                </span>
            </Note>
            <Section plain>
                {installed && shown.map(t => (
                    <ThemeCard
                        key={t.id}
                        theme={t}
                        installedVersion={installed[t.fileName]}
                        enabled={enabledThemes.includes(t.fileName)}
                        refresh={refresh}
                    />
                ))}
                {installed && !shown.length && <Empty icon={ICONS.search} title="No themes found." />}
            </Section>
        </>
    );
}
