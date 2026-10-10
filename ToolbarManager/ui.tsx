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
import { ContextMenuApi, Menu, showToast, Tooltip, useEffect, useRef, useState } from "@webpack/common";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { Badge, Button, confirm, Empty, IconButton, ICONS, Note, openWindow, Row, Section, Segmented, Sheet, TextField } from "../_ui";
import { activate, ATTR_ANCHOR, collapsedItemsNear, ItemHit, positionUnderDock, sanitizeSvg, stripUnsafe } from "./dom";
import { settings } from "./index";
import {
    applyBuiltinProfile, applyCustomProfile, Bar, BAR_LABEL, BARS, BUILTIN_PROFILES, ButtonState, data, DOCK_KEY, forget, getState,
    isVencordKey, listKeys, logger, placeKey, present, resetAll, runtime, setState, snapshotProfile, update, useToolbarData, vencordId
} from "./store";

export const cl = classNameFactory("vc-toolbarmanager-");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

// ---------------------------------------------------------------- Icons

const DOTS_PATH = "M4 12a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm6 0a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm8-2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z";

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
            // Snapshots of React-rendered icons carry no xmlns - without it the parser builds plain XML elements
            // that never paint (0×0 paths)
            const source = /^<svg[^>]*\sxmlns=/.test(html) ? html : html.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
            const doc = new DOMParser().parseFromString(source, "image/svg+xml");
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
        showToast("ToolbarManager: Failed to open menu", "failure");
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
                                        showToast("ToolbarManager: Button no longer exists", "failure");
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
                    icon={() => <DotsIcon className={classes(cl("dock-icon"), "vc-ui-tb-icon")} />}
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

/** The three zones of the editor - a button's zone is its state */
const ZONES: { value: ButtonState; label: string; empty: string; }[] = [
    { value: "visible", label: "Visible", empty: "Drag icons here to show them" },
    { value: "menu", label: "In ⋯ menu", empty: "Drag icons here to tuck them into the ⋯ menu" },
    { value: "hidden", label: "Hidden", empty: "Drag icons here to hide them" }
];

const KIND_LABEL = { vencord: "Vencord", native: "Discord", plugin: "Plugin" } as const;

function kindOf(bar: Bar, key: string) {
    const seen = data[bar].seen[key]?.kind;
    if (seen) return seen;
    if (bar === "chat" && isVencordKey(key)) return "vencord";
    return key.startsWith("t:vc-") ? "plugin" : "native";
}

function nameOf(bar: Bar, key: string) {
    if (key === DOCK_KEY[bar]) return "⋯ menu";
    return data[bar].seen[key]?.name ?? (isVencordKey(key) ? vencordId(key) : key.slice(2));
}

function isPresentKey(bar: Bar, key: string) {
    return present[bar].has(key) || (bar === "chat" && isVencordKey(key) && ChatBarButtonMap.has(vencordId(key)));
}

/** Click / right-click on a tile in the editor */
function openTileMenu(e: ReactMouseEvent, bar: Bar, key: string) {
    const state = getState(bar, key);
    const canForget = !isPresentKey(bar, key);

    openMenuAt(e, e.currentTarget, () => (
        <Menu.Menu navId="vc-toolbarmanager-tile" onClose={ContextMenuApi.closeContextMenu}>
            <Menu.MenuGroup label={nameOf(bar, key)}>
                {ZONES.map(z => (
                    <Menu.MenuRadioItem
                        key={z.value}
                        id={`vc-tbm-zone-${z.value}`}
                        group="vc-tbm-zone"
                        label={z.label}
                        checked={state === z.value}
                        action={() => setState(bar, key, z.value)}
                    />
                ))}
            </Menu.MenuGroup>
            {canForget && <Menu.MenuSeparator />}
            {canForget && (
                <Menu.MenuItem
                    id="vc-tbm-forget"
                    label="Forget"
                    subtext="Not currently shown - comes back once it is detected again"
                    color="danger"
                    action={() => forget(bar, key)}
                />
            )}
        </Menu.Menu>
    ));
}

interface Drop { zone: ButtonState; before: string | null; }

/** Insertion point from the pointer position - works across wrapped lines */
function dropBefore(zoneEl: HTMLElement, x: number, y: number): string | null {
    for (const tile of zoneEl.querySelectorAll<HTMLElement>("[data-tbm-key]")) {
        const r = tile.getBoundingClientRect();
        if (y < r.top) return tile.dataset.tbmKey!;
        if (y <= r.bottom && x < r.left + r.width / 2) return tile.dataset.tbmKey!;
    }
    return null;
}

function Tile({ bar, keyName, dragging, busy, dropBeforeThis, dropAfterThis, onDragStart, onDragEnd, onKeyMove }: {
    bar: Bar;
    keyName: string;
    dragging: boolean;
    /** Any drag running → no tooltips */
    busy: boolean;
    dropBeforeThis: boolean;
    dropAfterThis: boolean;
    onDragStart(): void;
    onDragEnd(): void;
    onKeyMove(dir: -1 | 1): void;
}) {
    const isDock = keyName === DOCK_KEY[bar];
    const isPresent = isDock || isPresentKey(bar, keyName);
    const kind = kindOf(bar, keyName);

    const tooltip = (
        <div className={cl("tooltip")}>
            <span className={cl("tooltip-name")}>{nameOf(bar, keyName)}</span>
            <span className={cl("tooltip-meta")}>
                {isDock
                    ? "Added by ToolbarManager - appears once something is in the ⋯ menu"
                    : `${KIND_LABEL[kind]}${isPresent ? "" : " · not currently shown"}`}
            </span>
        </div>
    );

    return (
        <Tooltip text={tooltip} hide={busy}>
            {tooltipProps => (
                <button
                    type="button"
                    {...tooltipProps}
                    data-tbm-key={keyName}
                    aria-label={nameOf(bar, keyName)}
                    className={classes(
                        cl("tile"),
                        cl(`tile-${getState(bar, keyName)}`),
                        !isPresent && cl("tile-absent"),
                        dragging && cl("tile-dragging"),
                        dropBeforeThis && cl("tile-drop-before"),
                        dropAfterThis && cl("tile-drop-after")
                    )}
                    draggable
                    onDragStart={e => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", keyName);
                        tooltipProps.onMouseLeave();
                        onDragStart();
                    }}
                    onDragEnd={onDragEnd}
                    onClick={e => {
                        tooltipProps.onClick();
                        if (!isDock) openTileMenu(e, bar, keyName);
                    }}
                    onContextMenu={e => {
                        e.preventDefault();
                        tooltipProps.onContextMenu();
                        if (!isDock) openTileMenu(e, bar, keyName);
                    }}
                    onKeyDown={e => {
                        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                            e.preventDefault();
                            onKeyMove(e.key === "ArrowLeft" ? -1 : 1);
                        }
                    }}
                >
                    <ButtonIcon bar={bar} keyName={keyName} />
                </button>
            )}
        </Tooltip>
    );
}

// ---------------------------------------------------------------- Settings: one bar (three zones)

/**
 * Mirrors the real bar: one row of icon tiles per zone. Dragging a tile reorders it (left/right)
 * and dragging it into another zone changes its state. Click or right-click opens a small menu.
 */
function BarEditor({ bar }: { bar: Bar; }) {
    useToolbarData();
    // Watch Vencord's own "show button" setting (hidden Vencord chat buttons)
    useSettings(["uiElements.chatBarButtons.*"]);
    const [drag, setDrag] = useState<string | null>(null);
    const [drop, setDrop] = useState<Drop | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    const keys = listKeys(bar);
    const dock = DOCK_KEY[bar];

    const endDrag = () => { setDrag(null); setDrop(null); };

    // Arrow keys: swap with the neighbour inside the same zone, keep the focus on the tile
    const keyMove = (key: string, zoneKeys: string[], dir: -1 | 1) => {
        const i = zoneKeys.indexOf(key);
        const j = i + dir;
        if (j < 0 || j >= zoneKeys.length) return;
        placeKey(bar, key, getState(bar, key), dir === -1 ? zoneKeys[j] : (zoneKeys[j + 1] ?? null));
        requestAnimationFrame(() => {
            rootRef.current?.querySelector<HTMLElement>(`[data-tbm-key="${CSS.escape(key)}"]`)?.focus();
        });
    };

    return (
        <Section title={BAR_LABEL[bar]} right={<Badge>{keys.length}</Badge>}>
            <div className={cl("editor")} ref={rootRef}>
            {keys.length === 0 && (
                <Empty
                    icon={DOTS_PATH}
                    title={bar === "chat"
                        ? "No buttons detected yet - open a chat once and they will show up here."
                        : "No icons detected yet - the title bar will be scanned on its next re-render."}
                />
            )}

            {keys.length > 0 && ZONES.map(zone => {
                const zoneKeys = keys.filter(k => getState(bar, k) === zone.value);
                // Our own ⋯ button can only be reordered, never moved to another zone
                const accepts = drag !== null && (drag !== dock || zone.value === "visible");
                const active = accepts && drop?.zone === zone.value;
                const last = zoneKeys[zoneKeys.length - 1];

                return (
                    <div key={zone.value} className={cl("zone")}>
                        <span className={cl("zone-label")}>{zone.label}</span>
                        <div
                            className={classes(cl("zone-row"), cl(`zone-row-${zone.value}`), active && cl("zone-row-over"))}
                            onDragOver={e => {
                                if (!accepts) return;
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "move";
                                const before = dropBefore(e.currentTarget, e.clientX, e.clientY);
                                if (drop?.zone !== zone.value || drop.before !== before) setDrop({ zone: zone.value, before });
                            }}
                            onDragLeave={e => {
                                if (!e.currentTarget.contains(e.relatedTarget as Node | null) && drop?.zone === zone.value) setDrop(null);
                            }}
                            onDrop={e => {
                                e.preventDefault();
                                if (accepts && drag) placeKey(bar, drag, zone.value, dropBefore(e.currentTarget, e.clientX, e.clientY));
                                endDrag();
                            }}
                        >
                            {zoneKeys.length === 0 && <span className={cl("zone-empty")}>{zone.empty}</span>}
                            {zoneKeys.map(key => (
                                <Tile
                                    key={key}
                                    bar={bar}
                                    keyName={key}
                                    dragging={drag === key}
                                    busy={drag !== null}
                                    dropBeforeThis={active && drop!.before === key && drag !== key}
                                    dropAfterThis={active && drop!.before === null && key === last && drag !== key}
                                    onDragStart={() => setDrag(key)}
                                    onDragEnd={endDrag}
                                    onKeyMove={dir => keyMove(key, zoneKeys, dir)}
                                />
                            ))}
                        </div>
                    </div>
                );
            })}
            </div>
        </Section>
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
        showToast(`Profile “${n}” saved`, "success");
    };

    const reset = async () => {
        if (await confirm({
            title: "Reset everything?",
            body: "All buttons become visible again and are shown in Discord's order. Detected buttons and custom profiles are kept.",
            confirmText: "Reset",
            cancelText: "Cancel",
            destructive: true
        })) resetAll();
    };

    return (
        <Section title="Profiles">
            <div className={cl("profiles")}>
                {BUILTIN_PROFILES.map(p => (
                    <Button key={p.id} variant="gray" small title={p.hint} onClick={() => applyBuiltinProfile(p.id)}>
                        {p.label}
                    </Button>
                ))}
                <Button variant="destructive" small onClick={reset}>Reset</Button>
            </div>

            {d.profiles.map(p => (
                <Row
                    key={p.id}
                    title={p.name}
                    trailing={<>
                        <Button variant="tinted" small onClick={() => applyCustomProfile(p)}>Apply</Button>
                        <IconButton
                            icon={ICONS.trash}
                            label="Delete profile"
                            destructive
                            onClick={() => update(dd => { dd.profiles = dd.profiles.filter(x => x.id !== p.id); })}
                        />
                    </>}
                />
            ))}

            <Row
                title={
                    <TextField
                        value={name}
                        maxLength={40}
                        placeholder="Save current setup as a profile…"
                        onChange={setName}
                        onKeyDown={e => { if (e.key === "Enter") save(); }}
                    />
                }
                trailing={<Button small disabled={!name.trim()} onClick={save}>Save</Button>}
            />
        </Section>
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
        <Section
            title="Quick menu on buttons"
            footer={<>
                {contextMenu === "right" && "Right-clicking a button shows “Hide / Move to ⋯ menu”. Shift + right-click shows the button's original menu."}
                {contextMenu === "shift" && "Only Shift + right-click shows “Hide / Move to ⋯ menu” - a normal right-click stays unchanged."}
                {contextMenu === "off" && "No quick menu - settings only here."}
            </>}
        >
            <div className={cl("segmented")}>
                <Segmented value={contextMenu} options={MENU_MODES} onChange={v => settings.store.contextMenu = v} />
            </div>
        </Section>
    );
}

// ---------------------------------------------------------------- Settings

const HEADER = { title: "Toolbar Manager", icon: DOTS_PATH, iconColor: "indigo" as const };

function ManagerContent() {
    return (
        <>
            <Note>
                Drag icons to reorder them, or into another row to show, tuck away or hide them. Click an icon for options.
                Buttons show up here once Discord has displayed them.
            </Note>
            {BARS.map(bar => <BarEditor key={bar} bar={bar} />)}
            <Profiles />
            <ContextMenuOption />
        </>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => (
    <Sheet embedded header={{ ...HEADER, subtitle: "Sort, hide or tuck away toolbar buttons" }}>
        <ManagerContent />
    </Sheet>
), { noop: true });

export function openManagerModal() {
    openWindow(close => (
        <Sheet header={HEADER} onClose={close} actions={[{ label: "Close", onClick: close }]}>
            <ManagerContent />
        </Sheet>
    ), { size: "medium" });
}
