/*
 * PluginHub – list, title bar button & window (built from the shared _ui kit)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { hasAnyVisibleSettings, isSettingHidden, pluginRequiresRestart } from "@api/PluginManager";
import { useSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { openPluginModal } from "@components/settings";
import { OptionType, Plugin } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { useMemo, useState } from "@webpack/common";

import { Badge, Button, Empty, Icon, IconButton, ICONS, Note, openWindow, Row, SearchField, Section, Segmented, Sheet, Toggle, ToggleRow } from "../_ui";
import { getOwnPlugins, isEnabled, isNew, markTried, needsRestart, setEnabled, settings } from "./index";
import { hubThemes, ThemesTab } from "./themes";

const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

const GRID_PATH = "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z";

// ---------------------------------------------------------------- List

function PluginRow({ plugin }: { plugin: Plugin; }) {
    const enabled = isEnabled(plugin);

    return (
        <Row
            title={
                <span className="vc-pluginhub-name">
                    {plugin.name}
                    {isNew(plugin) && <Badge color="blue" solid>New</Badge>}
                    {needsRestart(plugin) && <Badge color="orange">Restart required</Badge>}
                </span>
            }
            subtitle={plugin.description}
            trailing={
                <>
                    {enabled
                        ? hasAnyVisibleSettings(plugin) && (
                            <IconButton icon={ICONS.gear} label="Settings" onClick={() => { markTried(plugin); openPluginModal(plugin); }} />
                        )
                        : <IconButton icon={ICONS.info} label="What does this do?" onClick={() => openInfoModal(plugin)} />}
                    <Toggle checked={enabled} onChange={v => setEnabled(plugin, v)} label={plugin.name} />
                </>
            }
        />
    );
}

// ---------------------------------------------------------------- Info

const MENU_NAMES: Record<string, string> = {
    "message": "messages",
    "user-context": "users",
    "user-profile-actions": "user profiles",
    "channel-context": "channels",
    "thread-context": "threads",
    "gdm-context": "group DMs",
    "guild-context": "servers",
    "guild-header-popout": "the server menu",
    "textarea-context": "the chat box",
    "image-context": "images",
    "expression-picker": "emojis and stickers"
};

const menuName = (navId: string) => MENU_NAMES[navId] ?? navId.replace(/-context$/, "").replace(/-/g, " ");

/** What the plugin adds to Discord, read from its definition so it never gets out of date */
function getFeatures(p: Plugin) {
    const features: string[] = [];
    if ((p as any).renderTitleBarButton) features.push("An icon in the title bar");
    if (p.chatBarButton) features.push("A button in the chat bar");
    if (p.messagePopoverButton) features.push("A button when you hover over a message");
    if (p.renderMessageAccessory) features.push("Extra content under messages");
    if (p.contextMenus) {
        const menus = [...new Set(Object.keys(p.contextMenus).map(menuName))];
        features.push(`Right-click menu entries for ${menus.join(", ")}`);
    }
    if (p.commands?.length) features.push(`Commands: ${p.commands.map(c => "/" + c.name).join(", ")}`);
    if (p.toolboxActions) features.push(`In the Vencord toolbox: ${Object.keys(p.toolboxActions).join(", ")}`);
    return features;
}

function getOptions(p: Plugin) {
    const { settings } = p;
    if (!settings) return [];
    return Object.entries(settings.def)
        .filter(([, s]) => s.type !== OptionType.COMPONENT && s.type !== OptionType.CUSTOM && !isSettingHidden(settings, s))
        .map(([, s]) => (s as { description?: string; }).description)
        .filter(Boolean) as string[];
}

function InfoContent({ plugin }: { plugin: Plugin; }) {
    const features = getFeatures(plugin);
    const options = getOptions(plugin);
    const notes = [
        hasAnyVisibleSettings(plugin) && !options.length && "Has its own settings page once it is turned on.",
        pluginRequiresRestart(plugin) && "Turning it on takes effect after a restart."
    ].filter(Boolean) as string[];

    return (
        <>
            <p className="vc-pluginhub-info-desc">{plugin.description}</p>
            {features.length > 0 && (
                <Section title="What it adds">
                    {features.map(f => <Row key={f} title={f} />)}
                </Section>
            )}
            {options.length > 0 && (
                <Section title="Options">
                    {options.map(o => <Row key={o} title={o} />)}
                </Section>
            )}
            {notes.map(n => <Note key={n}>{n}</Note>)}
        </>
    );
}

export function openInfoModal(plugin: Plugin) {
    openWindow(close => (
        <Sheet
            header={{ title: plugin.name, subtitle: "Plugin", icon: GRID_PATH, iconColor: "indigo" }}
            onClose={close}
            actions={[
                { label: "Close", onClick: close },
                { label: "Turn on", onClick: () => { setEnabled(plugin, true); close(); } }
            ]}
        >
            <InfoContent plugin={plugin} />
        </Sheet>
    ), { size: "small" });
}

// ---------------------------------------------------------------- Hub

function Hub({ embedded, onClose }: { embedded?: boolean; onClose?(): void; }) {
    useSettings(["plugins.*"] as any);
    const { sort, tab, showTitleBarButton } = settings.use(["sort", "tab", "showTitleBarButton"]);
    const [query, setQuery] = useState("");

    const all = useMemo(getOwnPlugins, [sort]);
    const q = query.trim().toLowerCase();
    const shown = q
        ? all.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
        : all;

    const onCount = all.filter(isEnabled).length;
    const restartCount = all.filter(needsRestart).length;
    const themes = tab === "themes";

    const top = (
        <div className="vc-pluginhub-top">
            <Segmented
                value={tab}
                options={[
                    { value: "plugins", label: "Plugins", count: all.length },
                    { value: "themes", label: "Themes", count: hubThemes.length }
                ]}
                onChange={v => settings.store.tab = v}
            />
            <div className="vc-pluginhub-toolbar">
                <SearchField value={query} onChange={setQuery} placeholder={themes ? "Search themes…" : "Search plugins…"} />
                {!themes && (
                    <>
                        <Button variant="gray" small title="Change sort order" onClick={() => settings.store.sort = sort === "new" ? "az" : "new"}>
                            {sort === "new" ? "Newest first" : "A–Z"}
                        </Button>
                        <span className="vc-pluginhub-count">{onCount} of {all.length} on</span>
                    </>
                )}
            </div>
        </div>
    );

    return (
        <Sheet
            embedded={embedded}
            header={{ title: "Plugin Hub", subtitle: "Your plugins & themes", icon: GRID_PATH, iconColor: "indigo" }}
            onClose={onClose}
            top={top}
        >
            {themes ? <ThemesTab query={query} /> : (
                <>
                    {restartCount > 0 && (
                        <Note tone="warn">
                            <span className="vc-pluginhub-restart">
                                <span>{restartCount === 1 ? "1 change takes" : `${restartCount} changes take`} effect after a restart.</span>
                                <Button small onClick={() => location.reload()}>Restart now</Button>
                            </span>
                        </Note>
                    )}

                    <Section
                        right={
                            <span className="vc-pluginhub-bulk">
                                <Button variant="plain" small onClick={() => shown.forEach(p => setEnabled(p, true))}>{q ? "Matches on" : "All on"}</Button>
                                <Button variant="plain" small onClick={() => shown.forEach(p => setEnabled(p, false))}>{q ? "Matches off" : "All off"}</Button>
                            </span>
                        }
                        plain={!shown.length}
                    >
                        {shown.length
                            ? shown.map(p => <PluginRow key={p.name} plugin={p} />)
                            : <Empty icon={ICONS.search} title="No plugins found." />}
                    </Section>
                </>
            )}

            {embedded && (
                <Section title="Options">
                    <ToggleRow
                        icon={GRID_PATH}
                        color="indigo"
                        title="Show icon in the title bar"
                        checked={showTitleBarButton}
                        onChange={v => settings.store.showTitleBarButton = v}
                    />
                </Section>
            )}
        </Sheet>
    );
}

// ---------------------------------------------------------------- Settings & window

export const SettingsPanel = ErrorBoundary.wrap(() => <Hub embedded />, { noop: true });

export function openHubModal() {
    openWindow(close => <Hub onClose={close} />, { size: "large" });
}

// ---------------------------------------------------------------- Title bar

function TitleBarButton() {
    const { showTitleBarButton } = settings.use(["showTitleBarButton"]);
    if (!showTitleBarButton) return null;

    return (
        <HeaderBarIcon
            className="vc-pluginhub-tb"
            onClick={openHubModal}
            tooltip="Plugins & Themes"
            icon={() => <Icon path={GRID_PATH} size={20} className="vc-ui-tb-icon" />}
        />
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-pluginhub-titlebar" noop>
            <TitleBarButton />
        </ErrorBoundary>
    );
}
