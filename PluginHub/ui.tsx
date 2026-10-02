/*
 * PluginHub – list, title bar button, popout & window
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { hasAnyVisibleSettings, isSettingHidden, pluginRequiresRestart } from "@api/PluginManager";
import { useSettings } from "@api/Settings";
import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { openPluginModal } from "@components/settings";
import { Switch } from "@components/Switch";
import { classes } from "@utils/misc";
import { OptionType, Plugin } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { Modal, openModal, Popout, useMemo, useRef, useState } from "@webpack/common";

import { getOwnPlugins, isEnabled, isNew, markTried, needsRestart, setEnabled, settings } from "./index";

const cl = classNameFactory("vc-pluginhub-");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

// ---------------------------------------------------------------- Icons

const GRID_PATH = "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z";
const INFO_PATH = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5ZM13.5 17h-3v-1h1v-4h-1v-1h2v5h1v1Z";
const COG_PATH = "M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.9a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5-2.1-1.6ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z";

function Icon({ path, size = 20, className }: { path: string; size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={classes(cl("icon"), className)}>
            <path fill="currentColor" d={path} />
        </svg>
    );
}

// ---------------------------------------------------------------- List

function PluginRow({ plugin }: { plugin: Plugin; }) {
    const enabled = isEnabled(plugin);
    const restart = needsRestart(plugin);

    return (
        <div className={classes(cl("row"), enabled && cl("row-on"))}>
            <div className={cl("row-text")}>
                <div className={cl("row-name")}>
                    <span className={cl("row-title")}>{plugin.name}</span>
                    {isNew(plugin) && <span className={classes(cl("badge"), cl("badge-new"))}>New</span>}
                    {restart && <span className={cl("badge")}>Restart required</span>}
                </div>
                <div className={cl("row-desc")}>{plugin.description}</div>
            </div>
            {enabled
                ? hasAnyVisibleSettings(plugin) && (
                    <button className={cl("cog")} title="Settings" onClick={() => { markTried(plugin); openPluginModal(plugin); }}>
                        <Icon path={COG_PATH} size={18} />
                    </button>
                )
                : (
                    <button className={cl("cog")} title="What does this do?" onClick={() => openInfoModal(plugin)}>
                        <Icon path={INFO_PATH} size={18} />
                    </button>
                )}
            <Switch checked={enabled} onChange={v => setEnabled(plugin, v)} />
        </div>
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

    return (
        <div className={cl("info")}>
            <p className={cl("info-desc")}>{plugin.description}</p>

            {features.length > 0 && (
                <>
                    <h3 className={cl("info-h")}>What it adds</h3>
                    <ul className={cl("info-list")}>
                        {features.map(f => <li key={f}>{f}</li>)}
                    </ul>
                </>
            )}

            {options.length > 0 && (
                <>
                    <h3 className={cl("info-h")}>Options</h3>
                    <ul className={cl("info-list")}>
                        {options.map(o => <li key={o}>{o}</li>)}
                    </ul>
                </>
            )}

            {hasAnyVisibleSettings(plugin) && !options.length && (
                <p className={cl("info-note")}>Has its own settings page once it is turned on.</p>
            )}
            {pluginRequiresRestart(plugin) && (
                <p className={cl("info-note")}>Turning it on takes effect after a restart.</p>
            )}
        </div>
    );
}

export function openInfoModal(plugin: Plugin) {
    openModal(props => (
        <Modal
            {...props}
            size="sm"
            title={plugin.name}
            actions={[
                { text: "Close", variant: "secondary", onClick: props.onClose },
                { text: "Turn on", variant: "primary", onClick: () => { setEnabled(plugin, true); props.onClose(); } }
            ]}
        >
            <ErrorBoundary noop>
                <InfoContent plugin={plugin} />
            </ErrorBoundary>
        </Modal>
    ));
}

// ---------------------------------------------------------------- Hub

function Hub({ compact }: { compact?: boolean; }) {
    useSettings(["plugins.*"] as any);
    const { sort } = settings.use(["sort"]);
    const [query, setQuery] = useState("");

    const all = useMemo(getOwnPlugins, [sort]);
    const q = query.trim().toLowerCase();
    const shown = q
        ? all.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
        : all;

    const onCount = all.filter(isEnabled).length;
    const restartCount = all.filter(needsRestart).length;

    return (
        <div className={classes(cl("hub"), compact && cl("compact"))}>
            <div className={cl("toolbar")}>
                <input
                    className={cl("search")}
                    placeholder="Search plugins…"
                    value={query}
                    onChange={e => setQuery(e.currentTarget.value)}
                />
                <button
                    className={cl("btn")}
                    title="Change sort order"
                    onClick={() => settings.store.sort = sort === "new" ? "az" : "new"}
                >
                    {sort === "new" ? "Newest first" : "A–Z"}
                </button>
                <span className={cl("count")}>{onCount} of {all.length} on</span>
            </div>

            <div className={cl("actions")}>
                <button className={cl("btn")} onClick={() => shown.forEach(p => setEnabled(p, true))}>
                    {q ? "Matches on" : "All on"}
                </button>
                <button className={cl("btn")} onClick={() => shown.forEach(p => setEnabled(p, false))}>
                    {q ? "Matches off" : "All off"}
                </button>
            </div>

            {restartCount > 0 && (
                <div className={cl("restart")}>
                    <span>
                        {restartCount === 1 ? "1 change takes" : `${restartCount} changes take`} effect after a restart.
                    </span>
                    <button className={classes(cl("btn"), cl("btn-brand"))} onClick={() => location.reload()}>
                        Restart now
                    </button>
                </div>
            )}

            <div className={cl("list")}>
                {shown.map(p => <PluginRow key={p.name} plugin={p} />)}
                {!shown.length && <div className={cl("empty")}>No plugins found.</div>}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Settings & window

export const SettingsPanel = ErrorBoundary.wrap(() => {
    const { showTitleBarButton } = settings.use(["showTitleBarButton"]);

    return (
        <div className={cl("settings")}>
            <Hub />
            <label className={cl("option")}>
                <span>Show icon in the title bar</span>
                <Switch checked={showTitleBarButton} onChange={v => settings.store.showTitleBarButton = v} />
            </label>
        </div>
    );
}, { noop: true });

export function openHubModal() {
    openModal(props => (
        <Modal {...props} size="lg" title="My Plugins" actions={[{ text: "Close", variant: "secondary", onClick: props.onClose }]}>
            <ErrorBoundary noop>
                <Hub />
            </ErrorBoundary>
        </Modal>
    ));
}

// ---------------------------------------------------------------- Title bar

function PopoutPanel({ close }: { close(): void; }) {
    return (
        <div className={cl("popout")}>
            <div className={cl("header")}>
                <Icon path={GRID_PATH} size={20} />
                <span className={cl("title")}>My Plugins</span>
                <button className={cl("link")} onClick={() => { close(); openHubModal(); }}>Open larger</button>
            </div>
            <Hub compact />
        </div>
    );
}

function TitleBarButton() {
    const { showTitleBarButton } = settings.use(["showTitleBarButton"]);
    const buttonRef = useRef(null);
    const [show, setShow] = useState(false);

    if (!showTitleBarButton) return null;

    return (
        <Popout
            position="bottom"
            align="left"
            animation={Popout.Animation.NONE}
            shouldShow={show}
            onRequestClose={() => setShow(false)}
            targetElementRef={buttonRef}
            renderPopout={() => (
                <ErrorBoundary noop>
                    <PopoutPanel close={() => setShow(false)} />
                </ErrorBoundary>
            )}
        >
            {(_, { isShown }) => (
                <HeaderBarIcon
                    ref={buttonRef}
                    className={cl("btn-titlebar")}
                    onClick={() => setShow(v => !v)}
                    tooltip={isShown ? null : "My Plugins"}
                    icon={() => <Icon path={GRID_PATH} />}
                    selected={isShown}
                />
            )}
        </Popout>
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-pluginhub-titlebar" noop>
            <TitleBarButton />
        </ErrorBoundary>
    );
}
