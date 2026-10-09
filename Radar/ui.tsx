/*
 * Radar – title bar button, popout, settings & dialogs
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { copyWithToast } from "@utils/discord";
import { classes } from "@utils/misc";
import { useForceUpdater } from "@utils/react";
import { RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { Alerts, Modal, openModal, Popout, useEffect, useMemo, useRef, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { Avatar, Button, cl, Empty, Field, Icon, IconButton, IconName, RadarLogo, SectionTitle, Segmented, ToggleRow, useSlider } from "./components";
import { openRuleEditor, TriggerBadge } from "./editor";
import { ACTIONS, highlights, highlightSignal, jumpTo, placeLabel, removeHighlight, snapshotMessage, TRIGGERS } from "./engine";
import { settings } from "./index";
import { bookmarkMediaSize, collectMedia, formatBytes, openBookmarkFolder, removeOfflineMedia, saveMediaOffline, useMediaSrc } from "./media";
import { addBookmark, addReminder, allTags, clearDoneReminders, deleteBookmark, deleteReminder, findBookmark, formatRelative, formatWhen, getQuickPicks, parseTags, snoozeReminder } from "./reminders";
import { playSound, SOUND_OPTIONS } from "./sounds";
import { Bookmark, bookmarksStore, deleteRule, InboxItem, inboxStore, markAllRead, MessageSnapshot, Reminder, remindersStore, Rule, rulesStore, SavedMedia, toggleRule, useSignal, useStore } from "./store";

const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

// ---------------------------------------------------------------- Tabs

type TabId = "inbox" | "rules" | "reminders" | "bookmarks" | "options";

const TABS: { id: TabId; label: string; icon: IconName; }[] = [
    { id: "inbox", label: "History", icon: "inbox" },
    { id: "rules", label: "Rules", icon: "rules" },
    { id: "reminders", label: "Reminders", icon: "clock" },
    { id: "bookmarks", label: "Bookmarks", icon: "bookmark" },
    { id: "options", label: "", icon: "gear" }
];

function useUnreadCount() {
    const inbox = useStore(inboxStore);
    return inbox.reduce((n, i) => n + (i.read ? 0 : 1), 0);
}

function Tabs({ value, onChange }: { value: TabId; onChange(t: TabId): void; }) {
    const { refs, pos } = useSlider(value);
    const unread = useUnreadCount();
    const reminders = useStore(remindersStore);
    const upcoming = reminders.filter(r => !r.done).length;

    const badge = (id: TabId) => id === "inbox" ? unread : id === "reminders" ? upcoming : 0;

    return (
        <div className={cl("tabs")} role="tablist">
            <span
                className={classes(cl("tab-indicator"), pos.ready && cl("animated"))}
                style={{ transform: `translateX(${pos.left}px)`, width: pos.width }}
            />
            {TABS.map(t => (
                <button
                    key={t.id}
                    type="button"
                    role="tab"
                    title={t.label || "Options"}
                    aria-selected={t.id === value}
                    ref={n => { refs.current[t.id] = n; }}
                    className={classes(cl("tab"), !t.label && cl("tab-icon-only"), t.id === value && cl("tab-active"))}
                    onClick={() => onChange(t.id)}
                >
                    <Icon name={t.icon} size={16} />
                    {t.label && <span className={cl("tab-label")}>{t.label}</span>}
                    {badge(t.id) > 0 && <span className={classes(cl("tab-badge"), t.id !== "inbox" && cl("tab-badge-soft"))}>{badge(t.id) > 99 ? "99+" : badge(t.id)}</span>}
                </button>
            ))}
        </div>
    );
}

/** Redraw time labels regularly ("3 min ago") */
function useTicker(ms = 30_000) {
    const force = useForceUpdater();
    useEffect(() => {
        const id = setInterval(force, ms);
        return () => clearInterval(id);
    }, []);
}

function confirm(title: string, body: string, confirmText: string, onConfirm: () => void) {
    Alerts.show({ title, body, confirmText, cancelText: "Cancel", onConfirm });
}

// ---------------------------------------------------------------- History

const KIND_ICON: Record<string, IconName> = { reminder: "clock" };

function InboxRow({ item }: { item: InboxItem; }) {
    const icon = KIND_ICON[item.kind] ?? TRIGGERS[item.kind as keyof typeof TRIGGERS]?.icon ?? "bell";
    const canJump = !!item.channelId;
    const markRead = () => !item.read && inboxStore.update(list => list.map(i => i.id === item.id ? { ...i, read: true } : i));

    return (
        <div
            className={classes(cl("item"), !item.read && cl("item-unread"), canJump && cl("item-click"))}
            onClick={() => {
                markRead();
                if (canJump) jumpTo(item);
            }}
        >
            <span className={cl("item-avatar")}>
                <Avatar src={item.icon} fallback={icon} size={34} />
                <span className={cl("item-kind")}><Icon name={icon} size={11} /></span>
            </span>
            <span className={cl("item-main")}>
                <span className={cl("item-top")}>
                    <span className={cl("item-title")}>{item.title}</span>
                    <span className={cl("item-time")} title={new Date(item.at).toLocaleString("en-GB")}>{formatRelative(item.at)}</span>
                </span>
                <span className={cl("item-body")}>{item.body}</span>
                <span className={cl("item-rule")}>{item.ruleName}</span>
            </span>
            <span className={cl("item-actions")}>
                {canJump && <IconButton icon="jump" label="Jump there" onClick={() => { markRead(); jumpTo(item); }} />}
                {!item.read && <IconButton icon="check" label="Mark as read" onClick={markRead} />}
                <IconButton icon="trash" label="Remove" danger onClick={() => inboxStore.update(list => list.filter(i => i.id !== item.id))} />
            </span>
        </div>
    );
}

function InboxTab() {
    useTicker();
    const inbox = useStore(inboxStore);
    const [filter, setFilter] = useState<"all" | "unread">("all");
    const shown = filter === "unread" ? inbox.filter(i => !i.read) : inbox;
    const unread = inbox.filter(i => !i.read).length;

    return (
        <>
            <div className={cl("toolbar")}>
                <Segmented<"all" | "unread"> small value={filter} options={[{ value: "all", label: `All (${inbox.length})` }, { value: "unread", label: `Unread (${unread})` }]} onChange={setFilter} />
                <span className={cl("spacer")} />
                <IconButton icon="doneAll" label="Mark all as read" disabled={!unread} onClick={markAllRead} />
                <IconButton icon="trash" label="Clear history" danger disabled={!inbox.length} onClick={() => confirm("Clear history?", "All entries in the Radar history will be deleted.", "Clear", () => inboxStore.set([]))} />
            </div>
            {shown.length
                ? <div className={cl("list")}>{shown.slice(0, 150).map(i => <InboxRow key={i.id} item={i} />)}</div>
                : (
                    <Empty
                        icon="inbox"
                        title={filter === "unread" ? "All caught up" : "Nothing yet"}
                        hint={filter === "unread" ? "No unread hits." : "Hits from your rules (action “Add to Radar history”) and due reminders end up here."}
                    />
                )}
        </>
    );
}

// ---------------------------------------------------------------- Rules

function RuleCard({ rule, close }: { rule: Rule; close?(): void; }) {
    const tDef = TRIGGERS[rule.trigger.type];
    return (
        <div className={classes(cl("rule"), !rule.enabled && cl("rule-off"))}>
            <TriggerBadge type={rule.trigger.type} />
            <span className={cl("rule-main")} onClick={() => { close?.(); openRuleEditor(rule); }}>
                <span className={cl("rule-name")}>{rule.name}</span>
                <span className={cl("rule-summary")}>
                    <b>{tDef?.label ?? rule.trigger.type}</b>: {tDef?.summary(rule.trigger) ?? ""}
                </span>
                <span className={cl("rule-actions")}>
                    {rule.actions.map((a, i) => ACTIONS[a.type] && (
                        <span key={i} className={cl("rule-action")} title={ACTIONS[a.type].summary(a)}>
                            <Icon name={ACTIONS[a.type].icon} size={12} />
                            {ACTIONS[a.type].label}
                        </span>
                    ))}
                </span>
            </span>
            <span className={cl("rule-side")}>
                <span
                    role="switch"
                    aria-checked={rule.enabled}
                    tabIndex={0}
                    title={rule.enabled ? "Disable rule" : "Enable rule"}
                    className={classes(cl("switch"), rule.enabled && cl("switch-on"))}
                    onClick={() => toggleRule(rule.id, !rule.enabled)}
                    onKeyDown={e => (e.key === " " || e.key === "Enter") && toggleRule(rule.id, !rule.enabled)}
                >
                    <span className={cl("switch-knob")} />
                </span>
                <span className={cl("rule-buttons")}>
                    <IconButton icon="edit" label="Edit" onClick={() => { close?.(); openRuleEditor(rule); }} />
                    <IconButton icon="trash" label="Delete" danger onClick={() => confirm("Delete rule?", `“${rule.name}” will be permanently deleted.`, "Delete", () => deleteRule(rule.id))} />
                </span>
            </span>
        </div>
    );
}

function RulesTab({ close }: { close?(): void; }) {
    const rules = useStore(rulesStore);
    const active = rules.filter(r => r.enabled).length;
    const newRule = () => {
        close?.();
        openRuleEditor();
    };

    return (
        <>
            <div className={cl("toolbar")}>
                <span className={cl("row-hint")}>{rules.length ? `${active} of ${rules.length} rules active` : "No rules yet"}</span>
                <span className={cl("spacer")} />
                <Button icon="plus" small onClick={newRule}>New rule</Button>
            </div>
            {rules.length
                ? <div className={cl("list")}>{rules.map(r => <RuleCard key={r.id} rule={r} close={close} />)}</div>
                : (
                    <Empty icon="rules" title="When this happens, do that" hint="For example: keyword alert, friend joins voice, automatic “Do Not Disturb” while gaming.">
                        <Button icon="plus" onClick={newRule}>Create your first rule</Button>
                    </Empty>
                )}
        </>
    );
}

// ---------------------------------------------------------------- Reminders

function SnapshotPreview({ m, compact }: { m: MessageSnapshot; compact?: boolean; }) {
    return (
        <div className={classes(cl("snap"), compact && cl("snap-compact"))}>
            <Avatar src={m.authorAvatar} fallback="user" size={compact ? 20 : 24} />
            <span className={cl("snap-main")}>
                <span className={cl("snap-top")}>
                    <span className={cl("snap-author")}>{m.authorName}</span>
                    <span className={cl("row-hint")}>{m.guildId ? `#${m.channelName ?? "?"}${m.guildName ? ` · ${m.guildName}` : ""}` : placeLabel(null, m.channelId)}</span>
                </span>
                <span className={cl("snap-content")}>{m.content || (m.attachments ? `[${m.attachments} ${m.attachments === 1 ? "attachment" : "attachments"}]` : "[no text]")}</span>
            </span>
        </div>
    );
}

function ReminderRow({ r }: { r: Reminder; }) {
    const m = r.message;
    return (
        <div className={classes(cl("item"), r.done && cl("item-done"), m && cl("item-click"))} onClick={() => m && jumpTo(m)}>
            <span className={classes(cl("when"), r.missed && cl("when-missed"), !r.done && r.dueAt - Date.now() < 3600_000 && cl("when-soon"))}>
                <Icon name="clock" size={14} />
                <span>{r.done ? formatWhen(r.firedAt ?? r.dueAt) : formatRelative(r.dueAt)}</span>
            </span>
            <span className={cl("item-main")}>
                <span className={cl("item-top")}>
                    <span className={cl("item-title")}>{r.note || (m ? `Message from ${m.authorName}` : "Reminder")}</span>
                    {r.missed && <span className={cl("pill-warn")}>missed</span>}
                    <span className={cl("item-time")}>{formatWhen(r.dueAt)}</span>
                </span>
                {m && <SnapshotPreview m={m} compact />}
            </span>
            <span className={cl("item-actions")}>
                {m && <IconButton icon="jump" label="Go to message" onClick={() => jumpTo(m)} />}
                <IconButton icon="clock" label={r.done ? "Again in 1 hour" : "Postpone by 1 hour"} onClick={() => snoozeReminder(r.id, r.done ? 3600_000 : Math.max(0, r.dueAt - Date.now()) + 3600_000)} />
                <IconButton icon="trash" label="Delete" danger onClick={() => deleteReminder(r.id)} />
            </span>
        </div>
    );
}

function RemindersTab({ close }: { close?(): void; }) {
    useTicker();
    const reminders = useStore(remindersStore);
    const upcoming = reminders.filter(r => !r.done).sort((a, b) => a.dueAt - b.dueAt);
    const done = reminders.filter(r => r.done).sort((a, b) => (b.firedAt ?? b.dueAt) - (a.firedAt ?? a.dueAt));

    return (
        <>
            <div className={cl("toolbar")}>
                <span className={cl("row-hint")}>Right-click a message → “Remind me…”</span>
                <span className={cl("spacer")} />
                <Button icon="plus" small onClick={() => { close?.(); openReminderModal(); }}>New</Button>
            </div>
            <SectionTitle icon="clock">Upcoming ({upcoming.length})</SectionTitle>
            {upcoming.length
                ? <div className={cl("list")}>{upcoming.map(r => <ReminderRow key={r.id} r={r} />)}</div>
                : <Empty icon="clock" title="No upcoming reminders" />}
            {done.length > 0 && (
                <>
                    <SectionTitle icon="check" right={<button type="button" className={cl("link-btn")} onClick={clearDoneReminders}>Delete completed</button>}>
                        Completed ({done.length})
                    </SectionTitle>
                    <div className={cl("list")}>{done.slice(0, 50).map(r => <ReminderRow key={r.id} r={r} />)}</div>
                </>
            )}
        </>
    );
}

// ---------------------------------------------------------------- Bookmarks

/** Bigger pictures only load in the viewer */
const LAZY_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TILES = 4;

function MediaTile({ b, m, more, onOpen }: { b: Bookmark; m: SavedMedia; more?: number; onOpen(): void; }) {
    const thumb = m.kind === "image" && (m.size ?? 0) < LAZY_IMAGE_BYTES;
    const src = useMediaSrc(b.id, m.local, m.url, thumb);
    const [broken, setBroken] = useState(false);
    useEffect(() => setBroken(false), [src]);

    return (
        <button
            type="button"
            className={classes(cl("media-tile"), !thumb && cl("media-tile-plain"))}
            title={m.local ? `${m.name} · saved on this PC` : m.name}
            onClick={e => { e.stopPropagation(); onOpen(); }}
        >
            {thumb && src && !broken
                ? <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
                : (
                    <span className={cl("media-plain")}>
                        <Icon name={m.kind === "video" ? "play" : m.kind === "image" ? "image" : "file"} size={18} />
                        <span className={cl("media-name")}>{m.name}</span>
                    </span>
                )}
            {m.local && <span className={cl("media-saved")}><Icon name="check" size={9} /></span>}
            {more ? <span className={cl("media-more")}>+{more}</span> : null}
        </button>
    );
}

function MediaStrip({ b }: { b: Bookmark; }) {
    const media = b.media ?? [];
    if (!media.length) return null;
    const shown = media.slice(0, MAX_TILES);
    return (
        <span className={cl("media-strip")}>
            {shown.map((m, i) => (
                <MediaTile
                    key={m.key}
                    b={b}
                    m={m}
                    more={i === shown.length - 1 && media.length > MAX_TILES ? media.length - MAX_TILES : undefined}
                    onOpen={() => openMediaViewer(b.id, i)}
                />
            ))}
        </span>
    );
}

function SaveStatus({ b }: { b: Bookmark; }) {
    if (!b.offline) return null;
    if (b.saveState === "saving") return <span className={cl("bm-status")}><Icon name="download" size={11} />Saving on this PC…</span>;
    if (b.saveState === "failed") {
        return (
            <button
                type="button"
                className={classes(cl("bm-status"), cl("bm-status-warn"))}
                title="Discord's links expire after about a day. Open the message in Discord once, then try again."
                onClick={e => { e.stopPropagation(); saveMediaOffline(b); }}
            >
                Some files could not be saved · Retry
            </button>
        );
    }
    return <span className={classes(cl("bm-status"), cl("bm-status-ok"))}><Icon name="check" size={11} />Saved on this PC</span>;
}

function BookmarkRow({ b, onTag }: { b: Bookmark; onTag(t: string): void; }) {
    const m = b.message;
    const avatar = useMediaSrc(b.id, b.avatarLocal, m.authorAvatar);
    const hasMedia = !!b.media?.length;

    return (
        <div className={classes(cl("item"), cl("item-click"), cl("bm"))} onClick={() => jumpTo(m)}>
            <Avatar src={avatar} fallback="user" size={36} />
            <span className={cl("item-main")}>
                <span className={cl("item-top")}>
                    <span className={cl("item-title")}>{m.authorName}</span>
                    {m.authorUsername && m.authorUsername !== m.authorName && <span className={cl("bm-username")}>@{m.authorUsername}</span>}
                    <span className={cl("item-time")} title={`Saved ${new Date(b.createdAt).toLocaleString("en-GB")}`}>{formatWhen(m.timestamp)}</span>
                </span>
                <span className={cl("bm-meta")}>
                    {m.authorId && (
                        <button
                            type="button"
                            className={cl("bm-id")}
                            title="Copy user ID"
                            onClick={e => { e.stopPropagation(); copyWithToast(m.authorId, "User ID copied"); }}
                        >
                            <Icon name="copy" size={10} />
                            {m.authorId}
                        </button>
                    )}
                    <span className={cl("row-hint")}>{m.guildId ? `#${m.channelName ?? "?"}${m.guildName ? ` · ${m.guildName}` : ""}` : placeLabel(null, m.channelId)}</span>
                </span>
                {(m.content || !hasMedia) && (
                    <span className={cl("item-body")}>{m.content || (m.attachments ? `[${m.attachments} ${m.attachments === 1 ? "attachment" : "attachments"}]` : "[no text]")}</span>
                )}
                <MediaStrip b={b} />
                {b.note && <span className={cl("item-note")}>{b.note}</span>}
                {(b.tags.length > 0 || b.offline) && (
                    <span className={cl("tags")}>
                        <SaveStatus b={b} />
                        {b.tags.map(t => <button type="button" key={t} className={cl("tag")} onClick={e => { e.stopPropagation(); onTag(t); }}>#{t}</button>)}
                    </span>
                )}
            </span>
            <span className={cl("item-actions")}>
                <IconButton icon="jump" label="Go to message" onClick={() => jumpTo(m)} />
                {b.offline
                    ? <IconButton icon="folder" label="Show saved files" onClick={() => openBookmarkFolder(b.id)} />
                    : hasMedia && <IconButton icon="download" label="Save images & videos on this PC" onClick={() => saveMediaOffline(b)} />}
                <IconButton icon="edit" label="Edit bookmark" onClick={() => openBookmarkEditor(b)} />
                <IconButton icon="trash" label="Delete" danger onClick={() => deleteBookmark(b.id)} />
            </span>
        </div>
    );
}

function BookmarksTab() {
    const bookmarks = useStore(bookmarksStore);
    const [query, setQuery] = useState("");
    const [tag, setTag] = useState<string | null>(null);
    const tags = useMemo(allTags, [bookmarks]);

    const q = query.trim().toLowerCase();
    const shown = bookmarks.filter(b =>
        (!tag || b.tags.includes(tag))
        && (!q || [b.message.content, b.message.authorName, b.message.authorUsername, b.message.authorId, b.message.channelName, b.message.guildName, b.note, ...b.tags, ...(b.media ?? []).map(m => m.name)]
            .some(s => s?.toLowerCase().includes(q)))
    );

    return (
        <>
            <div className={cl("picker-box")}>
                <Icon name="search" size={16} className={cl("picker-search")} />
                <input className={cl("input")} value={query} placeholder="Search text, person, user ID, server, tag…" onChange={e => setQuery(e.currentTarget.value)} />
            </div>
            {tags.length > 0 && (
                <div className={cl("tags")}>
                    <button type="button" className={classes(cl("tag"), !tag && cl("tag-on"))} onClick={() => setTag(null)}>All</button>
                    {tags.map(t => <button type="button" key={t} className={classes(cl("tag"), tag === t && cl("tag-on"))} onClick={() => setTag(tag === t ? null : t)}>#{t}</button>)}
                </div>
            )}
            {shown.length
                ? <div className={cl("list")}>{shown.map(b => <BookmarkRow key={b.id} b={b} onTag={setTag} />)}</div>
                : (
                    <Empty
                        icon="bookmark"
                        title={bookmarks.length ? "Nothing found" : "No bookmarks yet"}
                        hint={bookmarks.length ? "Adjust your search or tag filter." : "Right-click any message, picture or video → “Save to Radar bookmarks”."}
                    />
                )}
        </>
    );
}

// ---------------------------------------------------------------- Options

function OptionsTab() {
    const s = settings.use(["showTitleBarButton", "cooldown", "reminderSound", "reminderVolume", "reminderFlash", "bookmarkSaveMedia"]);
    const [mediaBytes, setMediaBytes] = useState<number | null>(null);
    useEffect(() => { bookmarkMediaSize().then(setMediaBytes, () => setMediaBytes(null)); }, []);

    return (
        <>
            <SectionTitle icon="gear">General</SectionTitle>
            <div className={cl("card")}>
                <ToggleRow
                    checked={s.showTitleBarButton}
                    onChange={v => settings.store.showTitleBarButton = v}
                    icon="inbox"
                    label="Radar icon in the title bar"
                    hint="When hidden, you can reach Radar via the plugin settings and the Vencord Toolbox menu."
                />
                <div className={cl("row-static")}>
                    <span className={cl("row-text")}>
                        <span className={cl("row-label")}>Cooldown per rule</span>
                        <span className={cl("row-hint")}>Notification, sound and flashing at most every {s.cooldown} s per rule (history entries still count).</span>
                    </span>
                    <input type="range" min={0} max={120} step={5} value={s.cooldown} onChange={e => settings.store.cooldown = Number(e.currentTarget.value)} />
                    <span className={cl("range-value")}>{s.cooldown} s</span>
                </div>
            </div>

            <SectionTitle icon="clock">Reminders</SectionTitle>
            <div className={cl("card")}>
                <div className={cl("row-static")}>
                    <span className={cl("row-text")}>
                        <span className={cl("row-label")}>Sound</span>
                    </span>
                    <select className={cl("select")} value={s.reminderSound} onChange={e => settings.store.reminderSound = e.currentTarget.value}>
                        <option value="none">No sound</option>
                        {SOUND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <IconButton icon="play" label="Listen" disabled={s.reminderSound === "none"} onClick={() => playSound(s.reminderSound, s.reminderVolume)} />
                </div>
                <div className={cl("row-static")}>
                    <span className={cl("row-text")}>
                        <span className={cl("row-label")}>Volume</span>
                    </span>
                    <input type="range" min={5} max={100} step={5} value={s.reminderVolume} onChange={e => settings.store.reminderVolume = Number(e.currentTarget.value)} />
                    <span className={cl("range-value")}>{s.reminderVolume}%</span>
                </div>
                <ToggleRow checked={s.reminderFlash} onChange={v => settings.store.reminderFlash = v} icon="flash" label="Flash the taskbar on due reminders" />
            </div>

            <SectionTitle icon="bookmark">Bookmarks</SectionTitle>
            <div className={cl("card")}>
                <ToggleRow
                    checked={s.bookmarkSaveMedia}
                    onChange={v => settings.store.bookmarkSaveMedia = v}
                    icon="download"
                    label="Save images & videos of new bookmarks on this PC"
                    hint="They stay in the bookmark even if the message gets deleted. You can still change it per bookmark."
                />
                <div className={cl("row-static")}>
                    <span className={cl("row-text")}>
                        <span className={cl("row-label")}>Saved files</span>
                        <span className={cl("row-hint")}>{mediaBytes == null ? "…" : mediaBytes ? `${formatBytes(mediaBytes)} used` : "Nothing saved yet"}</span>
                    </span>
                    <Button icon="folder" small variant="secondary" onClick={() => openBookmarkFolder()}>Open folder</Button>
                </div>
            </div>

            <div className={cl("note")}>
                Radar works entirely locally: no messages are sent and no actions are performed on Discord - except
                changing your own status if you set that up in a rule.
            </div>
        </>
    );
}

// ---------------------------------------------------------------- Whole interface

export function RadarApp({ variant, close }: { variant: "popout" | "modal"; close?(): void; }) {
    const { lastTab } = settings.use(["lastTab"]);
    const tab = (TABS.some(t => t.id === lastTab) ? lastTab : "inbox") as TabId;
    const prev = useRef(tab);
    const dir = TABS.findIndex(t => t.id === tab) >= TABS.findIndex(t => t.id === prev.current) ? 1 : -1;
    useEffect(() => { prev.current = tab; }, [tab]);

    const unread = useUnreadCount();
    const rules = useStore(rulesStore);
    const activeRules = rules.filter(r => r.enabled).length;

    return (
        <div className={classes(cl("app"), cl(`app-${variant}`))}>
            <div className={cl("head")}>
                <span className={cl("logo")}>
                    <RadarLogo size={24} spin={activeRules > 0} />
                </span>
                <span className={cl("head-text")}>
                    <span className={cl("head-title")}>Radar</span>
                    <span className={cl("head-sub")}>
                        <span className={classes(cl("dot"), !activeRules && cl("dot-off"))} />
                        {activeRules ? `${activeRules} ${activeRules === 1 ? "rule" : "rules"} active` : "No rules active"}
                        {unread > 0 && ` · ${unread} unread`}
                    </span>
                </span>
            </div>

            <Tabs value={tab} onChange={t => settings.store.lastTab = t} />

            <div className={cl("scroller")}>
                <div key={tab} className={classes(cl("pane"), dir > 0 ? cl("pane-right") : cl("pane-left"))}>
                    {tab === "inbox" && <InboxTab />}
                    {tab === "rules" && <RulesTab close={close} />}
                    {tab === "reminders" && <RemindersTab close={close} />}
                    {tab === "bookmarks" && <BookmarksTab />}
                    {tab === "options" && <OptionsTab />}
                </div>
            </div>
        </div>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => <RadarApp variant="modal" />, { noop: true });

export function openRadarModal() {
    openModal(props => (
        <Modal {...props} size="md" title="Radar" actions={[{ text: "Close", variant: "secondary", onClick: props.onClose }]}>
            <ErrorBoundary>
                <RadarApp variant="modal" close={props.onClose} />
            </ErrorBoundary>
        </Modal>
    ));
}

// ---------------------------------------------------------------- Dialog: Reminder

function toLocalInput(ts: number) {
    const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000);
    return d.toISOString().slice(0, 16);
}

function ReminderModal({ modalProps, message }: { modalProps: RenderModalProps; message?: any; }) {
    const picks = useMemo(getQuickPicks, []);
    const [pick, setPick] = useState<string>(message ? picks[1].id : "custom");
    const [custom, setCustom] = useState(() => toLocalInput(Date.now() + 3600_000));
    const [note, setNote] = useState("");

    const due = pick === "custom" ? new Date(custom).getTime() : picks.find(p => p.id === pick)!.at();
    const invalid = !Number.isFinite(due) || due <= Date.now() || (!message && !note.trim());

    const save = () => {
        if (invalid) return;
        addReminder(due, note, message);
        modalProps.onClose();
    };

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Remind me…"
            subtitle={Number.isFinite(due) && due > Date.now() ? `${formatWhen(due)} (${formatRelative(due)})` : "Choose a time in the future"}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: "Remind", variant: "primary", onClick: save, disabled: invalid }
            ]}
        >
            <div className={cl("modal-body")}>
                <div className={cl("editor")}>
                    {message && <SnapshotPreview m={snapshotMessage(message)} />}
                    <div className={cl("picks")}>
                        {picks.map(p => (
                            <button type="button" key={p.id} className={classes(cl("pick"), pick === p.id && cl("pick-on"))} onClick={() => setPick(p.id)}>{p.label}</button>
                        ))}
                        <button type="button" className={classes(cl("pick"), pick === "custom" && cl("pick-on"))} onClick={() => setPick("custom")}>Custom time…</button>
                    </div>
                    {pick === "custom" && (
                        <Field label="Date & time">
                            <input type="datetime-local" className={cl("input")} value={custom} onChange={e => setCustom(e.currentTarget.value)} />
                        </Field>
                    )}
                    <Field label={message ? "Note (optional)" : "Note"}>
                        <textarea
                            className={classes(cl("input"), cl("textarea"))}
                            value={note}
                            rows={3}
                            maxLength={500}
                            placeholder={message ? "What should I remind you about?" : "e.g. Reply to Max"}
                            onChange={e => setNote(e.currentTarget.value)}
                        />
                    </Field>
                </div>
            </div>
        </Modal>
    );
}

export function openReminderModal(message?: any) {
    openModal(props => <ReminderModal modalProps={props} message={message} />);
}

// ---------------------------------------------------------------- Dialog: Bookmark

function BookmarkModal({ modalProps, message, existing }: { modalProps: RenderModalProps; message?: any; existing?: Bookmark; }) {
    const [tags, setTags] = useState((existing?.tags ?? []).join(", "));
    const [note, setNote] = useState(existing?.note ?? "");
    const [offline, setOffline] = useState(existing ? !!existing.offline : settings.store.bookmarkSaveMedia);
    const known = useMemo(allTags, []);
    const current = parseTags(tags);

    const preview = existing?.message ?? (message ? snapshotMessage(message) : null);
    const mediaCount = existing?.media?.length ?? (message ? collectMedia(message).length : 0);

    const save = () => {
        if (message) {
            addBookmark(message, current, note, offline);
        } else if (existing) {
            bookmarksStore.update(list => list.map(b => b.id === existing.id ? { ...b, tags: current, note: note.trim() } : b));
            const latest = bookmarksStore.value.find(b => b.id === existing.id);
            if (latest && offline && !existing.offline) saveMediaOffline(latest);
            if (latest && !offline && existing.offline) removeOfflineMedia(latest);
        }
        modalProps.onClose();
    };

    return (
        <Modal
            {...modalProps}
            size="sm"
            title={existing ? "Edit bookmark" : "Save to Radar bookmarks"}
            actions={[
                ...(existing ? [{ text: "Remove", variant: "critical-primary", onClick: () => { deleteBookmark(existing.id); modalProps.onClose(); } }] : []),
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: "Save", variant: "primary", onClick: save }
            ]}
        >
            <div className={cl("modal-body")}>
                <div className={cl("editor")}>
                    {preview && <SnapshotPreview m={preview} />}
                    <div className={cl("card")}>
                        <ToggleRow
                            checked={offline}
                            onChange={setOffline}
                            icon="download"
                            label={mediaCount ? `Save ${mediaCount === 1 ? "the image / video" : `all ${mediaCount} files`} on this PC` : "Save the avatar on this PC"}
                            hint={offline && existing?.offline
                                ? "Turning this off deletes the saved copies."
                                : "Stays in your bookmark even if the message or the account gets deleted."}
                        />
                    </div>
                    <Field label="Tags (optional)" hint="Separate with commas, e.g. “important, recipes”">
                        <input className={cl("input")} value={tags} placeholder="important, read later" onChange={e => setTags(e.currentTarget.value)} autoFocus />
                    </Field>
                    {known.length > 0 && (
                        <div className={cl("tags")}>
                            {known.filter(t => !current.includes(t)).slice(0, 12).map(t => (
                                <button type="button" key={t} className={cl("tag")} onClick={() => setTags(current.concat(t).join(", "))}>+ #{t}</button>
                            ))}
                        </div>
                    )}
                    <Field label="Note (optional)">
                        <input className={cl("input")} value={note} maxLength={300} onChange={e => setNote(e.currentTarget.value)} />
                    </Field>
                </div>
            </div>
        </Modal>
    );
}

export function openBookmarkModal(message: any) {
    const existing = findBookmark(message.id);
    openModal(props => existing
        ? <BookmarkModal modalProps={props} existing={existing} />
        : <BookmarkModal modalProps={props} message={message} />);
}

function openBookmarkEditor(existing: Bookmark) {
    openModal(props => <BookmarkModal modalProps={props} existing={existing} />);
}

// ---------------------------------------------------------------- Dialog: picture / video viewer

function MediaViewer({ modalProps, bookmarkId, start }: { modalProps: RenderModalProps; bookmarkId: string; start: number; }) {
    const bookmarks = useStore(bookmarksStore);
    const b = bookmarks.find(x => x.id === bookmarkId);
    const media = b?.media ?? [];
    const [index, setIndex] = useState(Math.min(start, Math.max(0, media.length - 1)));
    const m = media[index];
    const src = useMediaSrc(bookmarkId, m?.local, m?.url, !!m);
    const [broken, setBroken] = useState(false);
    useEffect(() => setBroken(false), [src]);

    const step = (d: number) => setIndex(i => (i + d + media.length) % media.length);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "ArrowLeft") step(-1);
            else if (e.key === "ArrowRight") step(1);
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [media.length]);

    if (!b || !m) return null;

    return (
        <Modal
            {...modalProps}
            size="lg"
            title={m.name}
            subtitle={`${b.message.authorName}${media.length > 1 ? ` · ${index + 1} of ${media.length}` : ""} · ${m.local ? "saved on this PC" : "from Discord, may disappear"}`}
            actions={[
                ...(b.offline ? [{ text: "Show in folder", variant: "secondary", onClick: () => openBookmarkFolder(b.id) }] : []),
                { text: "Go to message", variant: "secondary", onClick: () => { modalProps.onClose(); jumpTo(b.message); } },
                { text: "Close", variant: "primary", onClick: modalProps.onClose }
            ]}
        >
            <div className={cl("viewer")}>
                {media.length > 1 && <button type="button" className={classes(cl("viewer-nav"), cl("viewer-prev"))} aria-label="Previous" onClick={() => step(-1)}><Icon name="chevronLeft" size={22} /></button>}
                {!src
                    ? <span className={cl("row-hint")}>Loading…</span>
                    : broken
                        ? <Empty icon="image" title="Not available anymore" hint="Discord no longer has this file and it wasn't saved on this PC." />
                        : m.kind === "image"
                            ? <img key={src} src={src} alt={m.name} onError={() => setBroken(true)} />
                            : m.kind === "video"
                                ? <video key={src} src={src} controls autoPlay onError={() => setBroken(true)} />
                                : (
                                    <Empty icon="file" title={m.name} hint={m.size ? formatBytes(m.size) : undefined}>
                                        {b.offline && <Button icon="folder" onClick={() => openBookmarkFolder(b.id)}>Show in folder</Button>}
                                    </Empty>
                                )}
                {media.length > 1 && <button type="button" className={classes(cl("viewer-nav"), cl("viewer-next"))} aria-label="Next" onClick={() => step(1)}><Icon name="chevronRight" size={22} /></button>}
            </div>
        </Modal>
    );
}

function openMediaViewer(bookmarkId: string, start: number) {
    openModal(props => <MediaViewer modalProps={props} bookmarkId={bookmarkId} start={start} />);
}

// ---------------------------------------------------------------- Highlight under messages

export const HighlightChip = ErrorBoundary.wrap(({ message }: { message: any; }) => {
    useSignal(highlightSignal);
    const h = message?.id ? highlights.get(message.id) : undefined;
    if (!h) return null;
    return (
        <span className={cl("hl-chip")} style={{ "--vc-radar-hl": h.color } as React.CSSProperties}>
            <RadarLogo size={12} />
            <span>Radar · {h.ruleName}</span>
            <button type="button" className={cl("chip-x")} aria-label="Remove highlight" onClick={() => removeHighlight(message.id)}>
                <Icon name="close" size={10} />
            </button>
        </span>
    );
}, { noop: true });

// ---------------------------------------------------------------- Title bar

function TitleBarButton() {
    const { showTitleBarButton } = settings.use(["showTitleBarButton"]);
    const unread = useUnreadCount();
    const buttonRef = useRef(null);
    const [show, setShow] = useState(false);

    if (!showTitleBarButton) return null;

    const badge: ReactNode = unread > 0 && <span className={cl("badge")}>{unread > 99 ? "99+" : unread}</span>;

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
                    <div className={cl("popout")}>
                        <RadarApp variant="popout" close={() => setShow(false)} />
                    </div>
                </ErrorBoundary>
            )}
        >
            {(_, { isShown }) => (
                <HeaderBarIcon
                    ref={buttonRef}
                    className={classes(cl("btn-titlebar"), unread > 0 && cl("btn-titlebar-hot"))}
                    onClick={() => setShow(v => !v)}
                    tooltip={isShown ? null : unread ? `Radar – ${unread} unread` : "Radar"}
                    icon={() => (
                        <span className={cl("titlebar-icon")}>
                            <RadarLogo />
                            {badge}
                        </span>
                    )}
                    selected={isShown}
                />
            )}
        </Popout>
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-radar-titlebar" noop>
            <TitleBarButton />
        </ErrorBoundary>
    );
}
