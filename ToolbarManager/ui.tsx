/*
 * ToolbarManager – ⋯ buttons, menus, settings & dialog
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { ChatBarButton, ChatBarButtonFactory, ChatBarButtonMap } from "@api/ChatButtons";
import { useSettings } from "@api/Settings";
import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { findComponentByCodeLazy } from "@webpack";
import { Alerts, ContextMenuApi, Menu, Modal, openModal, showToast, Toasts, useEffect, useRef, useState } from "@webpack/common";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { activate, ATTR_ANCHOR, collapsedItemsNear, ItemHit, positionUnderDock, sanitizeSvg, stripUnsafe } from "./dom";
import { settings } from "./index";
import {
    applyBuiltinProfile, applyCustomProfile, Bar, BAR_LABEL, BARS, BUILTIN_PROFILES, ButtonState, data, DOCK_KEY, forget, getState,
    isVencordKey, listKeys, logger, moveKey, present, resetAll, runtime, setState, snapshotProfile, update, useToolbarData, vencordId
} from "./store";

export const cl = classNameFactory("vc-toolbarmanager-");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

// ---------------------------------------------------------------- Icons

const DOTS_PATH = "M4 12a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm6 0a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm8-2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z";
const GRIP_PATH = "M9 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm0 7a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-1.5 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM18 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-1.5 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM18 19a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z";

export function DotsIcon({ size = 20, className }: { size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={classes(cl("svg"), className)}>
            <path fill="currentColor" d={DOTS_PATH} />
        </svg>
    );
}

/** Safely display stored/cloned SVG (without innerHTML) */
function SnapshotIcon({ html }: { html: string; }) {
    const ref = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        const host = ref.current;
        if (!host) return;
        host.replaceChildren();
        try {
            const doc = new DOMParser().parseFromString(html, "image/svg+xml");
            const svg = doc.documentElement;
            if (svg.nodeName.toLowerCase() !== "svg") return;
            stripUnsafe(svg);
            svg.setAttribute("width", "20");
            svg.setAttribute("height", "20");
            host.appendChild(document.importNode(svg, true));
        } catch { /* the preview is optional */ }
    }, [html]);

    return <span ref={ref} className={cl("icon")} />;
}

function ButtonIcon({ bar, keyName }: { bar: Bar; keyName: string; }) {
    if (keyName === DOCK_KEY[bar]) return <span className={cl("icon")}><DotsIcon /></span>;

    if (bar === "chat" && isVencordKey(keyName)) {
        const Icon = ChatBarButtonMap.get(vencordId(keyName))?.icon;
        if (Icon) return (
            <span className={cl("icon")}>
                <ErrorBoundary noop><Icon width={20} height={20} /></ErrorBoundary>
            </span>
        );
    }

    const html = data[bar].seen[keyName]?.icon;
    if (html) return <SnapshotIcon html={html} />;

    const name = data[bar].seen[keyName]?.name ?? keyName.slice(2);
    return <span className={classes(cl("icon"), cl("icon-letter"))}>{name.charAt(0).toUpperCase()}</span>;
}

// ---------------------------------------------------------------- ⋯ menu

type AnyMouseEvent = ReactMouseEvent | MouseEvent;

/** Open the menu at the element - even if there is no usable mouse event */
function openMenuAt(e: AnyMouseEvent | undefined, anchor: Element, render: () => ReactNode) {
    let event: any = e;
    // Pass React events through directly; translate native events (capturing listener) or missing events
    // into a plain object whose target/currentTarget point at the button
    if (!event || !("nativeEvent" in event) || typeof event.pageX !== "number") {
        const r = anchor.getBoundingClientRect();
        const x = typeof event?.pageX === "number" ? event.pageX : r.left + r.width / 2;
        const y = typeof event?.pageY === "number" ? event.pageY : r.bottom;
        event = {
            pageX: x, pageY: y, clientX: x, clientY: y,
            target: anchor, currentTarget: anchor,
            shiftKey: false, type: "contextmenu", nativeEvent: e,
            preventDefault() { }, stopPropagation() { }
        };
    }
    try {
        ContextMenuApi.openContextMenu(event, render as any);
    } catch (err) {
        logger.error("Failed to open menu", err);
        showToast("ToolbarManager: Failed to open menu", Toasts.Type.FAILURE);
    }
}

export function openDockMenu(e: AnyMouseEvent | undefined, bar: Bar, dock: Element) {
    const items = collapsedItemsNear(bar, dock);
    positionUnderDock(dock);

    openMenuAt(e, dock, () => (
        <Menu.Menu navId="vc-toolbarmanager-dock" onClose={ContextMenuApi.closeContextMenu}>
            <Menu.MenuGroup label={bar === "chat" ? "More buttons" : "More icons"}>
                {items.length === 0 && <Menu.MenuItem id="vc-tbm-empty" label="Nothing in the ⋯ menu" disabled />}
                {items.map((item, i) => {
                    const html = item.el.querySelector("svg") ? sanitizeSvg(item.el.querySelector("svg")!) : undefined;
                    return (
                        <Menu.MenuItem
                            key={item.key}
                            id={`vc-tbm-item-${i}`}
                            label={item.name}
                            icon={html ? () => <SnapshotIcon html={html} /> : undefined}
                            action={() => {
                                // Trigger only after the menu has closed, otherwise Discord immediately closes the new popout again
                                setTimeout(() => {
                                    if (!item.el.isConnected) {
                                        showToast("ToolbarManager: Button no longer exists", Toasts.Type.FAILURE);
                                        return;
                                    }
                                    positionUnderDock(dock);
                                    activate(item.el);
                                }, 60);
                            }}
                        />
                    );
                })}
            </Menu.MenuGroup>
            <Menu.MenuSeparator />
            <Menu.MenuItem id="vc-tbm-manage" label="Manage toolbar…" action={openManagerModal} />
        </Menu.Menu>
    ));
}

/** Right-click on a button in the chat bar or title bar */
export function openItemMenu(e: MouseEvent, hit: ItemHit) {
    const isDock = hit.key === DOCK_KEY[hit.bar];
    const state = getState(hit.bar, hit.key);
    const name = data[hit.bar].seen[hit.key]?.name ?? hit.key.slice(2);

    openMenuAt(e, hit.el, () => (
        <Menu.Menu navId="vc-toolbarmanager-item" onClose={ContextMenuApi.closeContextMenu}>
            {!isDock && (
                <Menu.MenuGroup label={name}>
                    {state !== "visible" && <Menu.MenuItem id="vc-tbm-show" label="Show" action={() => setState(hit.bar, hit.key, "visible")} />}
                    {state !== "menu" && <Menu.MenuItem id="vc-tbm-collapse" label="Move to ⋯ menu" action={() => setState(hit.bar, hit.key, "menu")} />}
                    <Menu.MenuItem id="vc-tbm-hide" label="Hide" color="danger" action={() => setState(hit.bar, hit.key, "hidden")} />
                </Menu.MenuGroup>
            )}
            {!isDock && <Menu.MenuSeparator />}
            <Menu.MenuItem id="vc-tbm-manage" label="Manage toolbar…" action={openManagerModal} />
        </Menu.Menu>
    ));
}

// ---------------------------------------------------------------- ⋯ button in chat bar

function hasCollapsed(bar: Bar) {
    for (const k of present[bar]) if (getState(bar, k) === "menu") return true;
    return false;
}

export const ChatDockButton: ChatBarButtonFactory = () => {
    useToolbarData();
    if (!runtime.running || !hasCollapsed("chat")) return null;

    return (
        <ChatBarButton
            tooltip="More buttons"
            onClick={e => openDockMenu(e, "chat", e.currentTarget)}
        >
            <DotsIcon />
        </ChatBarButton>
    );
};

export const ChatDockIcon = () => <DotsIcon />;

// ---------------------------------------------------------------- ⋯ button in title bar

function TitleDock() {
    useToolbarData();
    const ref = useRef<HTMLElement>(null);
    if (!runtime.running) return null;

    return (
        <>
            <span {...{ [ATTR_ANCHOR]: "title" }} hidden />
            {hasCollapsed("title") && (
                <HeaderBarIcon
                    ref={ref}
                    className={cl("dock")}
                    onClick={(e?: ReactMouseEvent) => {
                        const el = (e?.currentTarget as Element | undefined) ?? ref.current;
                        if (el) openDockMenu(e, "title", el);
                    }}
                    tooltip="More icons"
                    icon={() => <DotsIcon className={cl("dock-icon")} />}
                />
            )}
        </>
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-toolbarmanager-titlebar" noop>
            <TitleDock />
        </ErrorBoundary>
    );
}

// ---------------------------------------------------------------- Settings: building blocks

const STATES: { value: ButtonState; label: string; }[] = [
    { value: "visible", label: "Visible" },
    { value: "menu", label: "In ⋯ menu" },
    { value: "hidden", label: "Hidden" }
];

function StateSwitch({ value, onChange }: { value: ButtonState; onChange(v: ButtonState): void; }) {
    return (
        <div className={cl("segmented")}>
            {STATES.map(s => (
                <button
                    type="button"
                    key={s.value}
                    className={classes(cl("segment"), s.value === value && cl(`segment-${s.value}`))}
                    onClick={() => onChange(s.value)}
                >
                    {s.label}
                </button>
            ))}
        </div>
    );
}

const KIND_LABEL = { vencord: "Vencord", native: "Discord", plugin: "Plugin" } as const;

function kindOf(bar: Bar, key: string) {
    const seen = data[bar].seen[key]?.kind;
    if (seen) return seen;
    if (bar === "chat" && isVencordKey(key)) return "vencord";
    return key.startsWith("t:vc-") ? "plugin" : "native";
}

function nameOf(bar: Bar, key: string) {
    if (key === DOCK_KEY[bar]) return "⋯ menu (ToolbarManager)";
    return data[bar].seen[key]?.name ?? (isVencordKey(key) ? vencordId(key) : key.slice(2));
}

// ---------------------------------------------------------------- Settings: list per bar

function BarList({ bar }: { bar: Bar; }) {
    useToolbarData();
    // Watch Vencord's own "show button" setting (hidden Vencord chat buttons)
    useSettings(["uiElements.chatBarButtons.*"]);
    const [drag, setDrag] = useState<string | null>(null);
    const [over, setOver] = useState<number | null>(null);

    const keys = listKeys(bar);

    return (
        <div className={cl("card")}>
            <div className={cl("card-title")}>
                <span>{BAR_LABEL[bar]}</span>
                <span className={cl("count")}>{keys.length}</span>
            </div>

            {keys.length === 0 && (
                <div className={cl("empty")}>
                    {bar === "chat"
                        ? "No buttons detected yet - open a chat once and they will show up here."
                        : "No icons detected yet - the title bar will be scanned on its next re-render."}
                </div>
            )}

            <div className={cl("list")}>
                {keys.map((key, i) => {
                    const isDock = key === DOCK_KEY[bar];
                    const isPresent = present[bar].has(key) || (bar === "chat" && isVencordKey(key) && ChatBarButtonMap.has(vencordId(key)));
                    const canForget = !isPresent && !isDock;
                    const kind = kindOf(bar, key);

                    return (
                        <div
                            key={key}
                            className={classes(cl("row"), drag === key && cl("row-dragging"), over === i && drag !== key && cl("row-over"))}
                            draggable
                            onDragStart={e => {
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData("text/plain", key);
                                setDrag(key);
                            }}
                            onDragOver={e => {
                                if (!drag) return;
                                e.preventDefault();
                                if (over !== i) setOver(i);
                            }}
                            onDrop={e => {
                                e.preventDefault();
                                if (drag) moveKey(bar, drag, i);
                                setDrag(null);
                                setOver(null);
                            }}
                            onDragEnd={() => { setDrag(null); setOver(null); }}
                        >
                            <svg viewBox="0 0 24 24" width={16} height={16} className={cl("grip")}>
                                <path fill="currentColor" d={GRIP_PATH} />
                            </svg>
                            <ButtonIcon bar={bar} keyName={key} />
                            <div className={cl("row-text")}>
                                <span className={cl("row-name")} title={key}>{nameOf(bar, key)}</span>
                                <span className={cl("row-meta")}>
                                    <span className={classes(cl("badge"), cl(`badge-${kind}`))}>{KIND_LABEL[kind]}</span>
                                    {!isPresent && !isDock && <span className={cl("muted")}>not currently shown</span>}
                                </span>
                            </div>

                            {isDock
                                ? <span className={cl("muted")}>appears once something is in the ⋯ menu</span>
                                : <StateSwitch value={getState(bar, key)} onChange={v => setState(bar, key, v)} />}

                            <div className={cl("row-actions")}>
                                <button type="button" className={cl("icon-btn")} title="Move up" disabled={i === 0} onClick={() => moveKey(bar, key, i - 1)}>▲</button>
                                <button type="button" className={cl("icon-btn")} title="Move down" disabled={i === keys.length - 1} onClick={() => moveKey(bar, key, i + 1)}>▼</button>
                                <button
                                    type="button"
                                    className={classes(cl("icon-btn"), cl("icon-btn-danger"))}
                                    title="Forget (will be re-added the next time it is detected)"
                                    disabled={!canForget}
                                    onClick={() => forget(bar, key)}
                                >
                                    ✕
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Settings: profiles

function Profiles() {
    const d = useToolbarData();
    const [name, setName] = useState("");

    const save = () => {
        const n = name.trim();
        if (!n) return;
        const p = snapshotProfile(n);
        update(dd => { dd.profiles = [...dd.profiles.filter(x => x.name !== n), p]; });
        setName("");
        showToast(`Profile “${n}” saved`, Toasts.Type.SUCCESS);
    };

    const reset = () => Alerts.show({
        title: "Reset everything?",
        body: "All buttons become visible again and are shown in Discord's order. Detected buttons and custom profiles are kept.",
        confirmText: "Reset",
        cancelText: "Cancel",
        onConfirm: resetAll
    });

    return (
        <div className={cl("card")}>
            <div className={cl("card-title")}><span>Profiles</span></div>
            <div className={cl("profiles")}>
                {BUILTIN_PROFILES.map(p => (
                    <button type="button" key={p.id} className={cl("btn")} title={p.hint} onClick={() => applyBuiltinProfile(p.id)}>
                        {p.label}
                    </button>
                ))}
                <button type="button" className={classes(cl("btn"), cl("btn-danger"))} onClick={reset}>Reset</button>
            </div>

            {d.profiles.length > 0 && (
                <div className={cl("custom-profiles")}>
                    {d.profiles.map(p => (
                        <div key={p.id} className={cl("custom-profile")}>
                            <span className={cl("row-name")}>{p.name}</span>
                            <button type="button" className={cl("btn")} onClick={() => applyCustomProfile(p)}>Anwenden</button>
                            <button
                                type="button"
                                className={classes(cl("icon-btn"), cl("icon-btn-danger"))}
                                title="Delete profile"
                                onClick={() => update(dd => { dd.profiles = dd.profiles.filter(x => x.id !== p.id); })}
                            >
                                ✕
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div className={cl("save-row")}>
                <input
                    className={cl("input")}
                    value={name}
                    maxLength={40}
                    placeholder="Save current setup as a profile…"
                    onChange={e => setName(e.currentTarget.value)}
                    onKeyDown={e => { if (e.key === "Enter") save(); }}
                />
                <button type="button" className={cl("btn")} disabled={!name.trim()} onClick={save}>Save</button>
            </div>
        </div>
    );
}

const MENU_MODES: { value: "right" | "shift" | "off"; label: string; }[] = [
    { value: "right", label: "Right-click" },
    { value: "shift", label: "Shift + right-click" },
    { value: "off", label: "Off" }
];

function ContextMenuOption() {
    const { contextMenu } = settings.use(["contextMenu"]);
    return (
        <div className={cl("card")}>
            <div className={cl("card-title")}><span>Quick menu on buttons</span></div>
            <div className={cl("segmented")}>
                {MENU_MODES.map(m => (
                    <button
                        type="button"
                        key={m.value}
                        className={classes(cl("segment"), contextMenu === m.value && cl("segment-visible"))}
                        onClick={() => settings.store.contextMenu = m.value}
                    >
                        {m.label}
                    </button>
                ))}
            </div>
            <div className={cl("muted")}>
                {contextMenu === "right" && "Right-clicking a button shows “Hide / Move to ⋯ menu”. Shift + right-click shows the button's original menu."}
                {contextMenu === "shift" && "Only Shift + right-click shows “Hide / Move to ⋯ menu” - a normal right-click stays unchanged."}
                {contextMenu === "off" && "No quick menu - settings only here."}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Settings

function ManagerPanel() {
    return (
        <div className={cl("settings")}>
            <div className={cl("hint")}>
                Buttons are detected automatically once they have been shown - open a chat for this.
                Change the order by dragging or with ▲▼. “In ⋯ menu” hides the button behind a ⋯ button,
                “Hidden” hides it completely. The text input and send button are never touched.
            </div>
            <Profiles />
            <ContextMenuOption />
            {BARS.map(bar => <BarList key={bar} bar={bar} />)}
        </div>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(ManagerPanel, { noop: true });

export function openManagerModal() {
    openModal(props => (
        <Modal {...props} size="md" title="Toolbar Manager" actions={[{ text: "Close", variant: "secondary", onClick: props.onClose }]}>
            <ErrorBoundary>
                <ManagerPanel />
            </ErrorBoundary>
        </Modal>
    ));
}
