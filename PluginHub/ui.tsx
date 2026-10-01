/*
 * PluginHub – list, title bar button, popout & window
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { hasAnyVisibleSettings } from "@api/PluginManager";
import { useSettings } from "@api/Settings";
import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { openPluginModal } from "@components/settings";
import { Switch } from "@components/Switch";
import { classes } from "@utils/misc";
import { Plugin } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { Modal, openModal, Popout, useMemo, useRef, useState } from "@webpack/common";

import { getOwnPlugins, isEnabled, needsRestart, setEnabled, settings } from "./index";

const cl = classNameFactory("vc-pluginhub-");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

// ---------------------------------------------------------------- Icons

const GRID_PATH = "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z";
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
                    {plugin.name}
                    {restart && <span className={cl("badge")}>Restart required</span>}
                </div>
                <div className={cl("row-desc")}>{plugin.description}</div>
            </div>
            {hasAnyVisibleSettings(plugin) && (
                <button
                    className={cl("cog")}
                    title="Settings"
                    disabled={!enabled}
                    onClick={() => openPluginModal(plugin)}
                >
                    <Icon path={COG_PATH} size={18} />
                </button>
            )}
            <Switch checked={enabled} onChange={v => setEnabled(plugin, v)} />
        </div>
    );
}

function Hub({ compact }: { compact?: boolean; }) {
    useSettings(["plugins.*"] as any);
    const [query, setQuery] = useState("");

    const all = useMemo(getOwnPlugins, []);
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
        <Modal {...props} size="md" title="My Plugins" actions={[{ text: "Close", variant: "secondary", onClick: props.onClose }]}>
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
