/*
 * MessageSelect – floating action bar, forward picker & screenshot preview
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import type { Channel } from "@vencord/discord-types";
import {
    ChannelStore, ConfirmModal, createRoot, GuildChannelStore, GuildStore, Modal, openModal, PermissionsBits, PermissionStore,
    PrivateChannelSortStore, SelectedChannelStore, useEffect, useMemo, useReducer, useRef, UserStore, useState
} from "@webpack/common";
import type { Root } from "react-dom/client";

import { copyPng, copySelected, deleteSelected, forwardSelected, logger, quoteSelected, savePng } from "./actions";
import { settings } from "./index";
import { canRenderShot, canvasToPng, renderScreenshot, ShotOptions } from "./screenshot";
import { cancelBusy, canDelete, clear, getChannel, getSelectedMessages, getVersion, state, subscribe } from "./store";

const cl = classNameFactory("vc-msgselect-");

// ---------------------------------------------------------------- Icons

const QUOTE_PATH = "M4 5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v4a6 6 0 0 1-6 6 1 1 0 1 1 0-2 4 4 0 0 0 4-4H6a2 2 0 0 1-2-2V5Zm9 0a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v4a6 6 0 0 1-6 6 1 1 0 1 1 0-2 4 4 0 0 0 4-4h-3a2 2 0 0 1-2-2V5Z";
const COPY_PATH = "M3 16a1 1 0 0 1-1-1V5a3 3 0 0 1 3-3h10a1 1 0 1 1 0 2H5a1 1 0 0 0-1 1v10a1 1 0 0 1-1 1Zm6-10h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Zm0 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H9Z";
const FORWARD_PATH = "M21.7 7.3a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4-1.4L18.58 9H13a7 7 0 0 0-7 7v4a1 1 0 1 1-2 0v-4a9 9 0 0 1 9-9h5.59l-3.3-3.3a1 1 0 0 1 1.42-1.4l5 5Z";
const CAMERA_PATH = "M9.4 3a2 2 0 0 0-1.7.9L6.5 6H5a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3h-1.5l-1.2-2.1a2 2 0 0 0-1.7-.9H9.4ZM12 17.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm0-2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z";
const TRASH_PATH = "M14.25 1c.41 0 .75.34.75.75V3h5.25c.41 0 .75.34.75.75v.5c0 .41-.34.75-.75.75H3.75A.75.75 0 0 1 3 4.25v-.5c0-.41.34-.75.75-.75H9V1.75c0-.41.34-.75.75-.75h4.5ZM5.06 7a1 1 0 0 0-1 1.06l.76 12.13a3 3 0 0 0 3 2.81h8.36a3 3 0 0 0 3-2.81l.75-12.13a1 1 0 0 0-1-1.06H5.07Z";
const CLOSE_PATH = "M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 0 0-1.4 1.4l4.9 4.9-4.9 4.9a1 1 0 1 0 1.4 1.4l4.9-4.9 4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z";
const CHECK_PATH = "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z";
const HASH_PATH = "M10.99 3.16A1 1 0 1 0 9 2.84L8.15 8H4a1 1 0 0 0 0 2h3.82l-.67 4H3a1 1 0 1 0 0 2h3.82l-.8 4.84a1 1 0 0 0 1.97.32L8.85 16h4.97l-.8 4.84a1 1 0 0 0 1.97.32l.86-5.16H20a1 1 0 1 0 0-2h-3.82l.67-4H21a1 1 0 1 0 0-2h-3.82l.8-4.84a1 1 0 1 0-1.97-.32L15.15 8h-4.97l.8-4.84ZM14.15 14l.67-4H9.85l-.67 4h4.97Z";
const AT_PATH = "M12 2a10 10 0 1 0 4.6 18.9 1 1 0 1 0-.9-1.8A8 8 0 1 1 20 12v1a2 2 0 0 1-4 0V8a1 1 0 1 0-2 0v.3A5 5 0 1 0 15 15.6 4 4 0 0 0 22 13v-1A10 10 0 0 0 12 2Zm0 13a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z";

export function Icon({ path, size = 18, className }: { path: string; size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={classes(cl("icon"), className)} aria-hidden>
            <path fill="currentColor" d={path} />
        </svg>
    );
}

// ---------------------------------------------------------------- State hook

function useSelection() {
    const [, force] = useReducer((n: number) => n + 1, 0);
    useEffect(() => subscribe(force), []);
    return getVersion();
}

// ---------------------------------------------------------------- Action bar

/** Finds the chat area of the selected channel to place the bar above its chat input */
function findChatRect(channelId: string): DOMRect | null {
    const item = document.querySelector(`[id^="chat-messages-${channelId}-"]`);
    const area = item?.closest('[class*="messagesWrapper"]')
        ?? item?.closest("main")
        ?? document.querySelector('main[class*="chatContent"]');
    const rect = area?.getBoundingClientRect();
    return rect && rect.width > 0 ? rect : null;
}

function useBarPosition(active: boolean, channelId: string | null) {
    const [pos, setPos] = useState<{ left: number; bottom: number; } | null>(null);

    useEffect(() => {
        if (!active || !channelId) return;
        const update = () => {
            const rect = findChatRect(channelId);
            setPos(prev => {
                const next = rect
                    ? { left: Math.round(rect.left + rect.width / 2), bottom: Math.round(window.innerHeight - rect.bottom + 16) }
                    : prev ?? { left: Math.round(window.innerWidth / 2), bottom: 96 };
                return prev && prev.left === next.left && prev.bottom === next.bottom ? prev : next;
            });
        };
        update();
        const timer = setInterval(update, 400);
        window.addEventListener("resize", update);
        return () => {
            clearInterval(timer);
            window.removeEventListener("resize", update);
        };
    }, [active, channelId]);

    return pos;
}

function BarButton({ path, label, onClick, danger, disabled, title }: { path: string; label: string; onClick(): void; danger?: boolean; disabled?: boolean; title?: string; }) {
    return (
        <button
            className={classes(cl("bar-btn"), danger && cl("bar-btn-danger"))}
            onClick={onClick}
            disabled={disabled}
            title={title ?? label}
        >
            <Icon path={path} size={16} />
            <span>{label}</span>
        </button>
    );
}

function ActionBar() {
    useSelection();
    const count = state.ids.size;
    const { busy, channelId } = state;
    const active = count > 0 || !!busy;
    const pos = useBarPosition(active, channelId);

    if (!active || !pos) return null;

    if (busy) {
        return (
            <div className={cl("bar")} style={{ left: pos.left, bottom: pos.bottom }}>
                <span className={cl("bar-count")}>{busy.cancelled ? "Stopping" : busy.label} {busy.done} / {busy.total}</span>
                <div className={cl("progress")}>
                    <div className={cl("progress-fill")} style={{ width: `${Math.round(busy.done / Math.max(1, busy.total) * 100)}%` }} />
                </div>
                <BarButton path={CLOSE_PATH} label="Stop" onClick={cancelBusy} disabled={busy.cancelled} />
            </div>
        );
    }

    const messages = getSelectedMessages();
    const channel = getChannel();
    const deletable = messages.filter(m => canDelete(m, channel)).length;
    const inChannel = SelectedChannelStore.getChannelId() === channelId;

    return (
        <div className={cl("bar")} style={{ left: pos.left, bottom: pos.bottom }} role="toolbar" aria-label="Selected messages">
            <span className={cl("bar-count")}>{count} selected</span>
            <div className={cl("bar-sep")} />
            <BarButton path={QUOTE_PATH} label="Quote" onClick={quoteSelected} disabled={!inChannel} title={inChannel ? "Quote in the chat box" : "Open the channel to quote"} />
            <BarButton path={COPY_PATH} label="Copy" onClick={copySelected} title="Copy as text" />
            <BarButton path={FORWARD_PATH} label="Forward" onClick={openForwardModal} />
            <BarButton path={CAMERA_PATH} label="Screenshot" onClick={openScreenshotModal} />
            <BarButton
                path={TRASH_PATH}
                label={deletable && deletable < count ? `Delete (${deletable})` : "Delete"}
                onClick={openDeleteModal}
                danger
                disabled={!deletable}
                title={deletable ? `Delete ${deletable} message${deletable === 1 ? "" : "s"}` : "You can't delete any of these messages"}
            />
            <div className={cl("bar-sep")} />
            <button className={cl("bar-close")} onClick={clear} title="Cancel (Esc)" aria-label="Cancel selection">
                <Icon path={CLOSE_PATH} size={18} />
            </button>
        </div>
    );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

export function mountBar() {
    if (root) return;
    container = document.createElement("div");
    container.id = "vc-msgselect-root";
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
        <ErrorBoundary noop>
            <ActionBar />
        </ErrorBoundary>
    );
}

export function unmountBar() {
    root?.unmount();
    root = null;
    container?.remove();
    container = null;
}

// ---------------------------------------------------------------- Delete

function openDeleteModal() {
    const messages = getSelectedMessages();
    const channel = getChannel();
    const deletable = messages.filter(m => canDelete(m, channel));
    if (!deletable.length) return;
    const skipped = messages.length - deletable.length;
    const n = deletable.length;

    openModal(props => (
        <ConfirmModal
            {...props}
            title={`Delete ${n} message${n === 1 ? "" : "s"}?`}
            confirmText="Delete"
            cancelText="Cancel"
            variant="critical-primary"
            onConfirm={() => {
                deleteSelected(deletable, Math.max(300, settings.store.deleteDelay ?? 1000)).catch(e => logger.error("Delete failed", e));
            }}
        >
            <ErrorBoundary noop>
                <div className={cl("confirm")}>
                    <p>This can't be undone. The messages are deleted one after another to avoid rate limits.</p>
                    {skipped > 0 && <p className={cl("muted")}>{skipped} selected message{skipped === 1 ? "" : "s"} can't be deleted by you and will be skipped.</p>}
                </div>
            </ErrorBoundary>
        </ConfirmModal>
    ));
}

// ---------------------------------------------------------------- Forward picker

interface Target {
    channel: Channel;
    label: string;
    sub: string;
    dm: boolean;
}

function dmLabel(channel: Channel) {
    if (channel.name) return channel.name;
    const names = (channel.recipients ?? []).map(id => {
        const u: any = UserStore.getUser(id);
        return u?.globalName || u?.username || "Unknown";
    });
    return names.join(", ") || "Direct Message";
}

function canSend(channel: Channel) {
    if (channel.isPrivate?.()) return true;
    try {
        const perm = channel.isThread?.() ? PermissionsBits.SEND_MESSAGES_IN_THREADS : PermissionsBits.SEND_MESSAGES;
        return PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel) && PermissionStore.can(perm, channel);
    } catch {
        return false;
    }
}

/** Text channels, announcement channels and threads */
const TEXT_TYPES = new Set([0, 5, 10, 11, 12]);

function collectTargets(): { dms: Target[]; guilds: Target[]; } {
    const dms: Target[] = [];
    try {
        for (const id of PrivateChannelSortStore.getPrivateChannelIds() ?? []) {
            const channel = ChannelStore.getChannel(id);
            if (channel) dms.push({ channel, label: dmLabel(channel), sub: channel.isGroupDM?.() ? "Group DM" : "Direct Message", dm: true });
        }
    } catch (e) {
        logger.warn("Couldn't list DMs", e);
    }

    const guilds: Target[] = [];
    try {
        const current = SelectedChannelStore.getChannelId();
        const currentGuild = current ? ChannelStore.getChannel(current)?.guild_id : null;
        const ids = Object.keys(GuildStore.getGuilds() ?? {});
        // Current server first
        if (currentGuild) ids.sort((a, b) => (b === currentGuild ? 1 : 0) - (a === currentGuild ? 1 : 0));

        for (const gid of ids) {
            const guild = GuildStore.getGuild(gid);
            const entries: any[] = (GuildChannelStore.getChannels(gid)?.SELECTABLE as any[]) ?? [];
            for (const entry of entries) {
                const channel: Channel | undefined = entry?.channel;
                if (!channel || !TEXT_TYPES.has(channel.type) || !canSend(channel)) continue;
                guilds.push({ channel, label: channel.name, sub: guild?.name ?? "", dm: false });
            }
        }
    } catch (e) {
        logger.warn("Couldn't list channels", e);
    }

    return { dms, guilds };
}

function ForwardPicker({ onPick }: { onPick(channel: Channel, mode: "native" | "text"): void; }) {
    const [query, setQuery] = useState("");
    const [asText, setAsText] = useState(settings.store.forwardMode === "text");
    const [active, setActive] = useState(0);
    const all = useMemo(collectTargets, []);
    const inputRef = useRef<HTMLInputElement>(null);

    const results = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) {
            const currentGuild = getChannel()?.guild_id;
            return [
                ...all.dms.slice(0, 12),
                ...all.guilds.filter(t => t.channel.guild_id === currentGuild).slice(0, 30)
            ];
        }
        const match = (t: Target) => t.label.toLowerCase().includes(q) || t.sub.toLowerCase().includes(q);
        return [...all.dms.filter(match), ...all.guilds.filter(match)].slice(0, 60);
    }, [query, all]);

    useEffect(() => setActive(0), [query]);
    useEffect(() => { setTimeout(() => inputRef.current?.focus(), 50); }, []);

    const pick = (t: Target | undefined) => t && onPick(t.channel, asText ? "text" : "native");

    return (
        <div className={cl("picker")}>
            <input
                ref={inputRef}
                className={cl("search")}
                placeholder="Search channels, DMs and servers"
                value={query}
                onChange={e => setQuery(e.currentTarget.value)}
                onKeyDown={e => {
                    if (e.key === "ArrowDown") setActive(a => Math.min(results.length - 1, a + 1));
                    else if (e.key === "ArrowUp") setActive(a => Math.max(0, a - 1));
                    else if (e.key === "Enter") pick(results[active]);
                    else return;
                    e.preventDefault();
                }}
            />
            <div className={cl("results")}>
                {results.length === 0 && <div className={cl("empty")}>Nothing found</div>}
                {results.map((t, i) => (
                    <button
                        key={t.channel.id}
                        className={classes(cl("result"), i === active && cl("result-active"))}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => pick(t)}
                    >
                        <Icon path={t.dm ? AT_PATH : HASH_PATH} size={18} className={cl("result-icon")} />
                        <span className={cl("result-name")}>{t.label}</span>
                        <span className={cl("result-sub")}>{t.sub}</span>
                    </button>
                ))}
            </div>
            <label className={cl("check")}>
                <input type="checkbox" checked={asText} onChange={e => setAsText(e.currentTarget.checked)} />
                <span>Send as quoted text instead of native forwards</span>
            </label>
        </div>
    );
}

function openForwardModal() {
    const count = state.ids.size;
    if (!count) return;

    openModal(props => (
        <Modal
            {...props}
            size="md"
            title={`Forward ${count} message${count === 1 ? "" : "s"}`}
            subtitle="Native forwards are sent one message at a time."
            actions={[{ text: "Cancel", variant: "secondary", onClick: props.onClose }]}
        >
            <ErrorBoundary noop>
                <ForwardPicker
                    onPick={(channel, mode) => {
                        props.onClose();
                        forwardSelected(channel, mode, Math.max(300, settings.store.deleteDelay ?? 1000)).catch(e => logger.error("Forward failed", e));
                    }}
                />
            </ErrorBoundary>
        </Modal>
    ));
}

// ---------------------------------------------------------------- Screenshot

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void; }) {
    return (
        <button className={classes(cl("toggle"), checked && cl("toggle-on"))} onClick={() => onChange(!checked)} role="switch" aria-checked={checked}>
            <span className={cl("toggle-box")}>{checked && <Icon path={CHECK_PATH} size={14} />}</span>
            <span>{label}</span>
        </button>
    );
}

function ScreenshotPreview({ messages, onReady }: { messages: ReturnType<typeof getSelectedMessages>; onReady(png: Blob | null): void; }) {
    const s = settings.use(["shotTheme", "shotHideNames", "shotHideAvatars", "shotImages"]);
    const [url, setUrl] = useState<string | null>(null);
    const [error, setError] = useState(false);
    const [loading, setLoading] = useState(true);

    const opts: ShotOptions = {
        theme: s.shotTheme === "light" ? "light" : "dark",
        hideNames: !!s.shotHideNames,
        hideAvatars: !!s.shotHideAvatars,
        showImages: !!s.shotImages
    };

    useEffect(() => {
        let cancelled = false;
        let objectUrl: string | null = null;
        setLoading(true);
        onReady(null);

        renderScreenshot(messages, opts)
            .then(canvasToPng)
            .then(png => {
                if (cancelled) return;
                objectUrl = URL.createObjectURL(png);
                setUrl(objectUrl);
                setError(false);
                onReady(png);
            })
            .catch(e => {
                logger.error("Screenshot failed", e);
                if (!cancelled) setError(true);
            })
            .finally(() => !cancelled && setLoading(false));

        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [opts.theme, opts.hideNames, opts.hideAvatars, opts.showImages]);

    return (
        <div className={cl("shot")}>
            <div className={cl("shot-options")}>
                <Toggle label="Hide names" checked={opts.hideNames} onChange={v => settings.store.shotHideNames = v} />
                <Toggle label="Hide avatars" checked={opts.hideAvatars} onChange={v => settings.store.shotHideAvatars = v} />
                <Toggle label="Show images" checked={opts.showImages} onChange={v => settings.store.shotImages = v} />
                <div className={cl("segmented")}>
                    {(["dark", "light"] as const).map(t => (
                        <button
                            key={t}
                            className={classes(cl("segment"), opts.theme === t && cl("segment-on"))}
                            onClick={() => settings.store.shotTheme = t}
                        >
                            {t === "dark" ? "Dark" : "Light"}
                        </button>
                    ))}
                </div>
            </div>
            <div className={classes(cl("shot-preview"), loading && cl("shot-loading"))}>
                {error
                    ? <div className={cl("empty")}>Couldn't render the screenshot.</div>
                    : url
                        ? <img src={url} alt="Screenshot preview" draggable={false} />
                        : <div className={cl("empty")}>Rendering</div>}
            </div>
        </div>
    );
}

function ScreenshotModal({ modalProps }: { modalProps: any; }) {
    const [messages] = useState(getSelectedMessages);
    const [png, setPng] = useState<Blob | null>(null);
    const name = `messages-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Message Screenshot"
            subtitle={`${messages.length} message${messages.length === 1 ? "" : "s"}`}
            actions={[
                { text: "Close", variant: "secondary", onClick: modalProps.onClose },
                { text: "Save", variant: "secondary", disabled: !png, onClick: () => png && savePng(png, name) },
                { text: "Copy image", variant: "primary", disabled: !png, onClick: () => png && copyPng(png) }
            ]}
        >
            <ErrorBoundary noop>
                <ScreenshotPreview messages={messages} onReady={setPng} />
            </ErrorBoundary>
        </Modal>
    );
}

function openScreenshotModal() {
    if (!canRenderShot(state.ids.size)) return;
    openModal(props => <ScreenshotModal modalProps={props} />);
}
