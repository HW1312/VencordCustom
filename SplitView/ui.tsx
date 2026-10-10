/*
 * SplitView – Panel container, drop zone, title bar button & settings
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { getCurrentChannel } from "@utils/discord";
import { classes } from "@utils/misc";
import { findComponentByCodeLazy } from "@webpack";
import { createRoot, Popout, ReactDOM, useEffect, useLayoutEffect, useReducer, useRef, useState } from "@webpack/common";
import type { Root } from "react-dom/client";

import { AppIcon, Avatar, Icon, IconButton, ICONS, LinkRow, Popover, Row, Section, Sheet, ToggleRow, UiColor } from "../_ui";
import { closePanel, DEFAULT_WIDTH, MAX_PANELS, MIN_WIDTH, openPanel, parsePanels, parseWidths, setPanelWidth, settings, toggleVisible } from "./index";
import { openInMain, Panel, useChannelInfo } from "./panel";

const cl = classNameFactory("vc-splitview-");
export const ICON_COLOR: UiColor = "indigo";
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

export const SPLIT_PATH = "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm2 0v14h7V5H5Zm9 0v14h5V5h-5Z";

/** Discord should always stay at least this wide */
const MIN_MAIN_WIDTH = 480;

// ---------------------------------------------------------------- Drag & drop state

export interface DragInfo {
    channelId: string;
    guildId: string | null;
}

let dragInfo: DragInfo | null = null;
const dragListeners = new Set<() => void>();

export function setDragInfo(info: DragInfo | null) {
    if (dragInfo === info) return;
    dragInfo = info;
    dragListeners.forEach(l => l());
}

function useDragInfo() {
    const [, force] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
        dragListeners.add(force);
        return () => void dragListeners.delete(force);
    }, []);
    return dragInfo;
}

function DropZone({ full }: { full: boolean; }) {
    const [over, setOver] = useState(false);

    return (
        <div
            className={classes(cl("dropzone"), over && cl("dropzone-over"))}
            onDragEnter={e => { e.preventDefault(); setOver(true); }}
            onDragOver={e => {
                e.preventDefault();
                e.dataTransfer.dropEffect = full ? "none" : "link";
            }}
            onDragLeave={() => setOver(false)}
            onDrop={e => {
                e.preventDefault();
                setOver(false);
                const info = dragInfo;
                setDragInfo(null);
                if (info) openPanel(info.channelId, info.guildId);
            }}
        >
            <AppIcon path={SPLIT_PATH} color={ICON_COLOR} size={48} />
            <div className={cl("dropzone-title")}>{full ? `Maximum of ${MAX_PANELS} panels` : "Drop here"}</div>
            <div className={cl("dropzone-sub")}>{full ? "Close a panel first" : "Open channel in SplitView"}</div>
        </div>
    );
}

// ---------------------------------------------------------------- Container

function useWindowWidth() {
    const [w, setW] = useState(window.innerWidth);
    useEffect(() => {
        const onResize = () => setW(window.innerWidth);
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);
    return w;
}

function setAppShrink(px: number) {
    const root = document.documentElement;
    if (px > 0) {
        root.style.setProperty("--vc-splitview-width", `${px}px`);
        root.classList.add("vc-splitview-active");
    } else {
        root.style.removeProperty("--vc-splitview-width");
        root.classList.remove("vc-splitview-active");
    }
}

function SplitViewRoot() {
    const { panels, widths, visible } = settings.use(["panels", "widths", "visible"]);
    const list = parsePanels(panels);
    const saved = parseWidths(widths);
    const winW = useWindowWidth();
    const drag = useDragInfo();

    // While dragging only local; saved on release
    const [live, setLive] = useState<number[] | null>(null);
    const liveRef = useRef<number[] | null>(null);

    const shown = visible && list.length > 0;
    const maxEach = Math.max(MIN_WIDTH, Math.floor((winW - MIN_MAIN_WIDTH) / Math.max(1, list.length)));
    const eff = (live ?? saved).map(w => Math.min(Math.max(w, MIN_WIDTH), maxEach));
    const total = shown ? list.reduce((sum, _, i) => sum + eff[i], 0) : 0;

    useLayoutEffect(() => setAppShrink(total), [total]);
    useEffect(() => () => setAppShrink(0), []);

    const onResizeStart = (index: number, e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const start = eff.slice();
        document.body.classList.add("vc-splitview-resizing");

        const onMove = (ev: MouseEvent) => {
            const next = start.slice();
            // The divider sits on the left of the panel: dragging left = wider
            next[index] = Math.min(Math.max(start[index] + (startX - ev.clientX), MIN_WIDTH), maxEach);
            liveRef.current = next;
            setLive(next);
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            document.body.classList.remove("vc-splitview-resizing");
            if (liveRef.current) setPanelWidth(index, liveRef.current[index]);
            liveRef.current = null;
            setLive(null);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    return (
        <div className={cl("root")}>
            {shown && (
                <div className={cl("panels")} style={{ width: total }}>
                    {list.map((p, i) => (
                        <ErrorBoundary key={p.channelId} message="This panel crashed.">
                            <Panel channelId={p.channelId} index={i} count={list.length} width={eff[i]} onResizeStart={onResizeStart} />
                        </ErrorBoundary>
                    ))}
                </div>
            )}
            {drag && <DropZone full={list.length >= MAX_PANELS && !list.some(p => p.channelId === drag.channelId)} />}
        </div>
    );
}

// ---------------------------------------------------------------- Mounting (portal in the Discord tree, otherwise own root)

let running = false;
let container: HTMLDivElement | null = null;
let fallbackRoot: Root | null = null;
const hosts: object[] = [];
const hostListeners = new Set<() => void>();

const stopKeys = (e: KeyboardEvent) => e.stopPropagation();

function getContainer() {
    if (!container) {
        container = document.createElement("div");
        container.className = cl("host");
        // Do not pass key presses in the panels on to Discord's global shortcuts (e.g. Esc = mark as read)
        container.addEventListener("keydown", stopKeys);
        document.body.appendChild(container);
    }
    return container;
}

const notifyHosts = () => hostListeners.forEach(l => l());

export function activate() {
    running = true;
    notifyHosts();
}

/** Called when the title bar patch does not apply */
export function mountFallbackRoot() {
    if (!running || hosts.length || fallbackRoot) return;
    fallbackRoot = createRoot(getContainer());
    fallbackRoot.render(
        <ErrorBoundary>
            <SplitViewRoot />
        </ErrorBoundary>
    );
}

export function unmountAll() {
    running = false;
    fallbackRoot?.unmount();
    fallbackRoot = null;
    notifyHosts();
    setAppShrink(0);
    document.body.classList.remove("vc-splitview-resizing");
    // Remove the portal only after the hosts have re-rendered
    const node = container;
    container = null;
    if (node) {
        node.removeEventListener("keydown", stopKeys);
        setTimeout(() => node.remove(), 0);
    }
}

/** Renders the panel container via portal – only the first host (in case there are several title bars) */
function PortalHost() {
    const [me] = useState(() => ({}));
    const [, force] = useReducer((x: number) => x + 1, 0);

    useLayoutEffect(() => {
        hostListeners.add(force);
        hosts.push(me);
        notifyHosts();
        return () => {
            hostListeners.delete(force);
            hosts.splice(hosts.indexOf(me), 1);
            notifyHosts();
        };
    }, []);

    if (!running || fallbackRoot || hosts[0] !== me) return null;
    return ReactDOM.createPortal(
        <ErrorBoundary>
            <SplitViewRoot />
        </ErrorBoundary>,
        getContainer()
    );
}

// ---------------------------------------------------------------- List of open panels

function PanelRow({ channelId }: { channelId: string; }) {
    const info = useChannelInfo(channelId);
    const guildId = info.channel?.guild_id ?? null;

    return (
        <Row
            leading={<Avatar src={info.icon ?? undefined} size={28} fallback={SPLIT_PATH} />}
            title={`${info.prefix}${info.name}`}
            subtitle={info.subtitle || undefined}
            onClick={() => openInMain(channelId, guildId)}
            trailing={<IconButton icon={ICONS.close} label="Close" destructive onClick={() => closePanel(channelId)} />}
        />
    );
}

function OpenPanels({ footer }: { footer?: string; }) {
    const { panels, visible } = settings.use(["panels", "visible"]);
    const list = parsePanels(panels);

    return (
        <>
            <Section>
                <ToggleRow icon={SPLIT_PATH} color={ICON_COLOR} title="Show SplitView" checked={visible} onChange={v => settings.store.visible = v} />
            </Section>
            <Section title={`Open panels (${list.length}/${MAX_PANELS})`} footer={footer}>
                {list.length
                    ? list.map(p => <PanelRow key={p.channelId} channelId={p.channelId} />)
                    : <Row title="No panels open yet." dim />}
                {list.length < MAX_PANELS && (
                    <LinkRow
                        icon={ICONS.plus}
                        onClick={() => {
                            const c = getCurrentChannel();
                            if (c) openPanel(c.id, c.guild_id);
                        }}
                    >
                        Open current channel
                    </LinkRow>
                )}
            </Section>
        </>
    );
}

// ---------------------------------------------------------------- Settings

export const SettingsPanel = ErrorBoundary.wrap(() => {
    const s = settings.use(["showTitleBarButton", "shortcut", "dragDrop", "showTyping"]);

    return (
        <Sheet embedded header={{ title: "SplitView", subtitle: "Up to two more channels next to the main window", icon: SPLIT_PATH, iconColor: ICON_COLOR }}>
            <OpenPanels />
            <Section
                title="Options"
                footer={'Open by right-clicking a channel/DM → "Open in SplitView", by dragging a channel to the right edge or with Ctrl + Shift + S. Messages in the panels are not marked as read.'}
            >
                <ToggleRow title="Show icon in the title bar" checked={s.showTitleBarButton} onChange={v => settings.store.showTitleBarButton = v} />
                <ToggleRow title="Ctrl + Shift + S opens the current channel" checked={s.shortcut} onChange={v => settings.store.shortcut = v} />
                <ToggleRow title="Open channels via drag & drop" checked={s.dragDrop} onChange={v => settings.store.dragDrop = v} />
                <ToggleRow title="Show who is currently typing" checked={s.showTyping} onChange={v => settings.store.showTyping = v} />
                <LinkRow icon={ICONS.refresh} onClick={() => settings.store.widths = `[${DEFAULT_WIDTH},${DEFAULT_WIDTH}]`}>
                    Reset panel widths
                </LinkRow>
            </Section>
        </Sheet>
    );
}, { noop: true });

// ---------------------------------------------------------------- Title bar

function PopoutPanel() {
    return (
        <Popover width={320} className={cl("popout")}>
            <Sheet header={{ title: "SplitView", icon: SPLIT_PATH, iconColor: ICON_COLOR }}>
                <OpenPanels footer={'Right-click a channel → "Open in SplitView" · Ctrl + Shift + S'} />
            </Sheet>
        </Popover>
    );
}

function TitleBarButton() {
    const { showTitleBarButton, visible, panels } = settings.use(["showTitleBarButton", "visible", "panels"]);
    const count = parsePanels(panels).length;
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
                    <PopoutPanel />
                </ErrorBoundary>
            )}
        >
            {(_, { isShown }) => (
                <HeaderBarIcon
                    ref={buttonRef}
                    className={classes(cl("btn"), visible && count > 0 && cl("btn-active"))}
                    onClick={() => setShow(v => !v)}
                    onContextMenu={(e: React.MouseEvent) => {
                        e.preventDefault();
                        toggleVisible();
                    }}
                    tooltip={isShown ? null : count ? `SplitView (${count} open)` : "SplitView"}
                    icon={() => <Icon path={SPLIT_PATH} size={20} className="vc-ui-tb-icon" />}
                    selected={isShown}
                />
            )}
        </Popout>
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-splitview-titlebar" noop>
            <PortalHost />
            <TitleBarButton />
        </ErrorBoundary>
    );
}
