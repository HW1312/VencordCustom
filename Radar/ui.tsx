/*
 * Radar – title bar button, popout, settings & dialogs (built from the shared _ui kit)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { copyWithToast } from "@utils/discord";
import { classes } from "@utils/misc";
import { useForceUpdater } from "@utils/react";
import { findComponentByCodeLazy } from "@webpack";
import { Popout, useEffect, useMemo, useRef, useState } from "@webpack/common";
import type { CSSProperties, ReactNode } from "react";

import { AppIcon, Avatar, Badge, Button, confirm, Empty, Field, Glyph, Icon, IconButton, ICONS, Note, openWindow, Pill, Pills, Popover, RoundButton, Row, SearchField, Section, Segmented, Select, Sheet, Slider, TextArea, TextField, Toggle, ToggleRow } from "../_ui";
import { ACTION_COLOR, cl, RadarIcon, RadarLogo, RI } from "./components";
import { openRuleEditor, TriggerGlyph } from "./editor";
import { ACTIONS, highlights, highlightSignal, jumpTo, placeLabel, removeHighlight, snapshotMessage, TRIGGERS } from "./engine";
import { settings } from "./index";
import { bookmarkMediaSize, collectMedia, formatBytes, openBookmarkFolder, removeOfflineMedia, saveMediaOffline, useMediaSrc } from "./media";
import { addBookmark, addReminder, allTags, clearDoneReminders, deleteBookmark, deleteReminder, findBookmark, formatRelative, formatWhen, getQuickPicks, parseTags, snoozeReminder } from "./reminders";
import { playSound, SOUND_OPTIONS } from "./sounds";
import { Bookmark, bookmarksStore, deleteRule, InboxItem, inboxStore, markAllRead, MessageSnapshot, Reminder, remindersStore, Rule, rulesStore, SavedMedia, toggleRule, useSignal, useStore } from "./store";

const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');
const POPOUT_STYLE: CSSProperties = { height: "min(660px, calc(100vh - 72px))", transformOrigin: "top left" };

// ---------------------------------------------------------------- Helpers

type TabId = "inbox" | "rules" | "reminders" | "bookmarks" | "options";
const TAB_IDS: TabId[] = ["inbox", "rules", "reminders", "bookmarks", "options"];

function useUnreadCount() {
    const inbox = useStore(inboxStore);
    return inbox.reduce((n, i) => n + (i.read ? 0 : 1), 0);
}

/** Redraw time labels regularly ("3 min ago") */
function useTicker(ms = 30_000) {
    const force = useForceUpdater();
    useEffect(() => {
        const id = setInterval(force, ms);
        return () => clearInterval(id);
    }, []);
}

const placeOf = (m: MessageSnapshot) => m.guildId ? `#${m.channelName ?? "?"}${m.guildName ? ` · ${m.guildName}` : ""}` : placeLabel(null, m.channelId);
const textOf = (m: MessageSnapshot) => m.content || (m.attachments ? `[${m.attachments} ${m.attachments === 1 ? "attachment" : "attachments"}]` : "[no text]");

/** Bar above a list: hint or filter on the left, buttons on the right */
function Toolbar({ children }: { children: ReactNode; }) {
    return <div className={cl("toolbar")}>{children}</div>;
}

/** Row actions, faint until the row is hovered */
function Actions({ children }: { children: ReactNode; }) {
    return <span className={cl("actions")}>{children}</span>;
}

function Time({ at, title }: { at: string; title?: string; }) {
    return <span className={cl("time")} title={title}>{at}</span>;
}

// ---------------------------------------------------------------- History

const KIND_ICON: Record<string, RadarIcon> = { reminder: "clock" };

function InboxRow({ item }: { item: InboxItem; }) {
    const icon: RadarIcon = KIND_ICON[item.kind] ?? TRIGGERS[item.kind as keyof typeof TRIGGERS]?.icon ?? "bell";
    const canJump = !!item.channelId;
    const markRead = () => !item.read && inboxStore.update(list => list.map(i => i.id === item.id ? { ...i, read: true } : i));

    return (
        <Row
            className={cl("item")}
            align="top"
            leading={
                <span className={cl("lead")}>
                    {!item.read && <span className={cl("unread-dot")} />}
                    <Avatar src={item.icon} fallback={RI[icon]} size={34} />
                    <span className={cl("kind")}><Icon path={RI[icon]} size={10} /></span>
                </span>
            }
            title={item.title}
            subtitle={<span className={cl("clip")}>{item.body}</span>}
            note={item.ruleName}
            onClick={() => {
                markRead();
                if (canJump) jumpTo(item);
            }}
            trailing={<>
                <Time at={formatRelative(item.at)} title={new Date(item.at).toLocaleString("en-GB")} />
                <Actions>
                    {canJump && <IconButton icon={RI.jump} label="Jump there" onClick={() => { markRead(); jumpTo(item); }} />}
                    {!item.read && <IconButton icon={ICONS.check} label="Mark as read" onClick={markRead} />}
                    <IconButton icon={ICONS.trash} label="Remove" destructive onClick={() => inboxStore.update(list => list.filter(i => i.id !== item.id))} />
                </Actions>
            </>}
        />
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
            <Toolbar>
                <Segmented<"all" | "unread"> small value={filter} options={[{ value: "all", label: "All", count: inbox.length }, { value: "unread", label: "Unread", count: unread }]} onChange={setFilter} />
                <IconButton icon={RI.doneAll} label="Mark all as read" disabled={!unread} onClick={markAllRead} />
                <IconButton
                    icon={ICONS.trash}
                    label="Clear history"
                    destructive
                    disabled={!inbox.length}
                    onClick={async () => {
                        if (await confirm({ title: "Clear history?", body: "All entries in the Radar history will be deleted.", confirmText: "Clear", destructive: true })) inboxStore.set([]);
                    }}
                />
            </Toolbar>
            {shown.length
                ? <Section>{shown.slice(0, 150).map(i => <InboxRow key={i.id} item={i} />)}</Section>
                : (
                    <Empty
                        icon={RI.inbox}
                        title={filter === "unread" ? "All caught up" : "Nothing yet"}
                        hint={filter === "unread" ? "No unread hits." : "Hits from your rules (action “Add to Radar history”) and due reminders end up here."}
                    />
                )}
        </>
    );
}

// ---------------------------------------------------------------- Rules

function RuleRow({ rule, close }: { rule: Rule; close?(): void; }) {
    const tDef = TRIGGERS[rule.trigger.type];
    const edit = () => { close?.(); openRuleEditor(rule); };

    return (
        <Row
            className={cl("item")}
            align="top"
            leading={<TriggerGlyph type={rule.trigger.type} size={32} />}
            title={rule.name}
            subtitle={<span className={cl("clip")}><b>{tDef?.label ?? rule.trigger.type}</b>: {tDef?.summary(rule.trigger) ?? ""}</span>}
            dim={!rule.enabled}
            onClick={edit}
            trailing={<>
                <Actions>
                    <IconButton icon={ICONS.edit} label="Edit" onClick={edit} />
                    <IconButton
                        icon={ICONS.trash}
                        label="Delete"
                        destructive
                        onClick={async () => {
                            if (await confirm({ title: "Delete rule?", body: `“${rule.name}” will be permanently deleted.`, confirmText: "Delete", destructive: true })) deleteRule(rule.id);
                        }}
                    />
                </Actions>
                <Toggle checked={rule.enabled} label={rule.enabled ? "Disable rule" : "Enable rule"} onChange={v => toggleRule(rule.id, v)} />
            </>}
        >
            <span className={cl("badges")}>
                {rule.actions.map((a, i) => ACTIONS[a.type] && (
                    <Badge key={i} color={ACTION_COLOR[a.type]} icon={RI[ACTIONS[a.type].icon]} title={ACTIONS[a.type].summary(a)}>{ACTIONS[a.type].label}</Badge>
                ))}
            </span>
        </Row>
    );
}

function RulesTab({ close }: { close?(): void; }) {
    const rules = useStore(rulesStore);
    const active = rules.filter(r => r.enabled).length;
    const newRule = () => {
        close?.();
        openRuleEditor();
    };

    if (!rules.length) {
        return (
            <Empty icon={RI.rules} title="When this happens, do that" hint="For example: keyword alert, friend joins voice, automatic “Do Not Disturb” while gaming.">
                <Button icon={ICONS.plus} onClick={newRule}>Create your first rule</Button>
            </Empty>
        );
    }

    return (
        <>
            <Toolbar>
                <span className={cl("dim")}>{active} of {rules.length} rules active</span>
                <Button icon={ICONS.plus} small onClick={newRule}>New rule</Button>
            </Toolbar>
            <Section>{rules.map(r => <RuleRow key={r.id} rule={r} close={close} />)}</Section>
        </>
    );
}

// ---------------------------------------------------------------- Reminders

function SnapshotPreview({ m, compact }: { m: MessageSnapshot; compact?: boolean; }) {
    return (
        <div className={classes(cl("snap"), compact && cl("snap-compact"))}>
            <Avatar src={m.authorAvatar} size={compact ? 20 : 26} />
            <span className={cl("snap-main")}>
                <span className={cl("snap-top")}>
                    <b>{m.authorName}</b>
                    <span className={cl("dim")}>{placeOf(m)}</span>
                </span>
                <span className={cl("snap-content")}>{textOf(m)}</span>
            </span>
        </div>
    );
}

function ReminderRow({ r }: { r: Reminder; }) {
    const m = r.message;
    const soon = !r.done && r.dueAt - Date.now() < 3600_000;

    return (
        <Row
            className={cl("item")}
            align="top"
            leading={<Glyph path={RI.clock} color={r.done ? "gray" : r.missed ? "red" : soon ? "orange" : "blue"} />}
            title={<>{r.note || (m ? `Message from ${m.authorName}` : "Reminder")}{r.missed && <> <Badge color="red">missed</Badge></>}</>}
            subtitle={<>
                <span>{r.done ? formatWhen(r.firedAt ?? r.dueAt) : formatRelative(r.dueAt)}</span>
                {!r.done && <span>{formatWhen(r.dueAt)}</span>}
            </>}
            dim={r.done}
            onClick={m ? () => jumpTo(m) : undefined}
            trailing={
                <Actions>
                    {m && <IconButton icon={RI.jump} label="Go to message" onClick={() => jumpTo(m)} />}
                    <IconButton icon={RI.clock} label={r.done ? "Again in 1 hour" : "Postpone by 1 hour"} onClick={() => snoozeReminder(r.id, r.done ? 3600_000 : Math.max(0, r.dueAt - Date.now()) + 3600_000)} />
                    <IconButton icon={ICONS.trash} label="Delete" destructive onClick={() => deleteReminder(r.id)} />
                </Actions>
            }
        >
            {m && <SnapshotPreview m={m} compact />}
        </Row>
    );
}

function RemindersTab({ close }: { close?(): void; }) {
    useTicker();
    const reminders = useStore(remindersStore);
    const upcoming = reminders.filter(r => !r.done).sort((a, b) => a.dueAt - b.dueAt);
    const done = reminders.filter(r => r.done).sort((a, b) => (b.firedAt ?? b.dueAt) - (a.firedAt ?? a.dueAt));

    return (
        <>
            <Toolbar>
                <span className={cl("dim")}>Right-click a message → “Remind me…”</span>
                <Button icon={ICONS.plus} small onClick={() => { close?.(); openReminderModal(); }}>New</Button>
            </Toolbar>
            {upcoming.length
                ? <Section title={`Upcoming (${upcoming.length})`}>{upcoming.map(r => <ReminderRow key={r.id} r={r} />)}</Section>
                : <Empty icon={RI.clock} title="No upcoming reminders" />}
            {done.length > 0 && (
                <Section title={`Completed (${done.length})`} right={<Button small variant="plain" onClick={clearDoneReminders}>Delete completed</Button>}>
                    {done.slice(0, 50).map(r => <ReminderRow key={r.id} r={r} />)}
                </Section>
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
            className={cl("tile-media")}
            title={m.local ? `${m.name} · saved on this PC` : m.name}
            onClick={e => { e.stopPropagation(); onOpen(); }}
        >
            {thumb && src && !broken
                ? <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
                : (
                    <span className={cl("tile-plain")}>
                        <Icon path={m.kind === "video" ? ICONS.play : m.kind === "image" ? RI.image : RI.file} size={18} />
                        <span>{m.name}</span>
                    </span>
                )}
            {m.local && <span className={cl("tile-saved")}><Icon path={ICONS.check} size={9} /></span>}
            {more ? <span className={cl("tile-more")}>+{more}</span> : null}
        </button>
    );
}

function MediaStrip({ b }: { b: Bookmark; }) {
    const media = b.media ?? [];
    if (!media.length) return null;
    const shown = media.slice(0, MAX_TILES);
    return (
        <div className={cl("media")}>
            {shown.map((m, i) => (
                <MediaTile
                    key={m.key}
                    b={b}
                    m={m}
                    more={i === shown.length - 1 && media.length > MAX_TILES ? media.length - MAX_TILES : undefined}
                    onOpen={() => openMediaViewer(b.id, i)}
                />
            ))}
        </div>
    );
}

function SaveStatus({ b }: { b: Bookmark; }) {
    if (!b.offline) return null;
    if (b.saveState === "saving") return <Badge icon={ICONS.download}>Saving on this PC…</Badge>;
    if (b.saveState === "failed") {
        return (
            <Badge
                color="orange"
                title="Discord's links expire after about a day. Open the message in Discord once, then try again."
                onClick={() => saveMediaOffline(b)}
            >
                Some files could not be saved · Retry
            </Badge>
        );
    }
    return <Badge color="green" icon={ICONS.check}>Saved on this PC</Badge>;
}

function BookmarkRow({ b, onTag }: { b: Bookmark; onTag(t: string): void; }) {
    const m = b.message;
    const avatar = useMediaSrc(b.id, b.avatarLocal, m.authorAvatar);
    const hasMedia = !!b.media?.length;

    return (
        <Row
            className={cl("item")}
            align="top"
            leading={<Avatar src={avatar} size={36} />}
            title={<>
                {m.authorName}
                {m.authorUsername && m.authorUsername !== m.authorName && <span className={cl("handle")}>@{m.authorUsername}</span>}
            </>}
            subtitle={<>
                {m.authorId && (
                    <button
                        type="button"
                        className={cl("id")}
                        title="Copy user ID"
                        onClick={e => { e.stopPropagation(); copyWithToast(m.authorId, "User ID copied"); }}
                    >
                        <Icon path={ICONS.copy} size={10} />
                        {m.authorId}
                    </button>
                )}
                <span className={cl("clip")}>{placeOf(m)}</span>
            </>}
            onClick={() => jumpTo(m)}
            trailing={<>
                <Time at={formatWhen(m.timestamp)} title={`Saved ${new Date(b.createdAt).toLocaleString("en-GB")}`} />
                <Actions>
                    <IconButton icon={RI.jump} label="Go to message" onClick={() => jumpTo(m)} />
                    {b.offline
                        ? <IconButton icon={ICONS.folder} label="Show saved files" onClick={() => openBookmarkFolder(b.id)} />
                        : hasMedia && <IconButton icon={ICONS.download} label="Save images & videos on this PC" onClick={() => saveMediaOffline(b)} />}
                    <IconButton icon={ICONS.edit} label="Edit bookmark" onClick={() => openBookmarkEditor(b)} />
                    <IconButton icon={ICONS.trash} label="Delete" destructive onClick={() => deleteBookmark(b.id)} />
                </Actions>
            </>}
        >
            {(m.content || !hasMedia) && <div className={cl("text")}>{textOf(m)}</div>}
            <MediaStrip b={b} />
            {b.note && <div className={cl("text-note")}>{b.note}</div>}
            {(b.tags.length > 0 || b.offline) && (
                <div className={cl("row-pills")}>
                    <Pills>
                        <SaveStatus b={b} />
                        {b.tags.map(t => <Pill key={t} onClick={() => onTag(t)}>#{t}</Pill>)}
                    </Pills>
                </div>
            )}
        </Row>
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
            <SearchField value={query} placeholder="Search text, person, user ID, server, tag…" onChange={setQuery} />
            {tags.length > 0 && (
                <div className={cl("tag-bar")}>
                    <Pills>
                        <Pill selected={!tag} onClick={() => setTag(null)}>All</Pill>
                        {tags.map(t => <Pill key={t} selected={tag === t} onClick={() => setTag(tag === t ? null : t)}>#{t}</Pill>)}
                    </Pills>
                </div>
            )}
            {shown.length
                ? <Section>{shown.map(b => <BookmarkRow key={b.id} b={b} onTag={setTag} />)}</Section>
                : (
                    <Empty
                        icon={RI.bookmark}
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
            <Section title="General">
                <ToggleRow
                    icon={RI.inbox}
                    color="green"
                    title="Radar icon in the title bar"
                    subtitle="When hidden, you can reach Radar via the plugin settings and the Vencord Toolbox menu."
                    checked={s.showTitleBarButton}
                    onChange={v => settings.store.showTitleBarButton = v}
                />
                <Row
                    leading={<Glyph path={RI.flash} color="orange" />}
                    title="Cooldown per rule"
                    subtitle={`Notification, sound and flashing at most every ${s.cooldown} s per rule (history entries still count).`}
                    trailing={<Slider value={s.cooldown} min={0} max={120} step={5} format={v => `${v} s`} onChange={v => settings.store.cooldown = v} />}
                />
            </Section>

            <Section title="Reminders">
                <Row
                    leading={<Glyph path={RI.sound} color="pink" />}
                    title="Sound"
                    trailing={<>
                        <Select<string> width={150} value={s.reminderSound} options={[{ value: "none", label: "No sound" }, ...SOUND_OPTIONS]} onChange={v => settings.store.reminderSound = v} />
                        <IconButton icon={ICONS.play} label="Listen" disabled={s.reminderSound === "none"} onClick={() => playSound(s.reminderSound, s.reminderVolume)} />
                    </>}
                />
                <Row
                    leading={<Glyph path={RI.voiceIn} color="gray" />}
                    title="Volume"
                    trailing={<Slider value={s.reminderVolume} min={5} max={100} step={5} format={v => `${v}%`} onChange={v => settings.store.reminderVolume = v} />}
                />
                <ToggleRow icon={RI.flash} color="yellow" title="Flash the taskbar on due reminders" checked={s.reminderFlash} onChange={v => settings.store.reminderFlash = v} />
            </Section>

            <Section title="Bookmarks">
                <ToggleRow
                    icon={ICONS.download}
                    color="blue"
                    title="Save images & videos of new bookmarks on this PC"
                    subtitle="They stay in the bookmark even if the message gets deleted. You can still change it per bookmark."
                    checked={s.bookmarkSaveMedia}
                    onChange={v => settings.store.bookmarkSaveMedia = v}
                />
                <Row
                    leading={<Glyph path={ICONS.folder} color="teal" />}
                    title="Saved files"
                    subtitle={mediaBytes == null ? "…" : mediaBytes ? `${formatBytes(mediaBytes)} used` : "Nothing saved yet"}
                    trailing={<Button icon={ICONS.folder} small variant="gray" onClick={() => openBookmarkFolder()}>Open folder</Button>}
                />
            </Section>

            <div className={cl("options-note")}>
                <Note>
                    Radar works entirely locally: no messages are sent and no actions are performed on Discord - except
                    changing your own status if you set that up in a rule.
                </Note>
            </div>
        </>
    );
}

// ---------------------------------------------------------------- Whole interface

export function RadarApp({ variant, close }: { variant: "popout" | "modal" | "embedded"; close?(): void; }) {
    const { lastTab } = settings.use(["lastTab"]);
    const tab = (TAB_IDS.includes(lastTab as TabId) ? lastTab : "inbox") as TabId;
    const setTab = (t: TabId) => settings.store.lastTab = t;

    const unread = useUnreadCount();
    const rules = useStore(rulesStore);
    const reminders = useStore(remindersStore);
    const activeRules = rules.filter(r => r.enabled).length;
    const upcoming = reminders.filter(r => !r.done).length;

    const subtitle = (activeRules ? `${activeRules} ${activeRules === 1 ? "rule" : "rules"} active` : "No rules active") + (unread > 0 ? ` · ${unread} unread` : "");

    return (
        <Sheet
            embedded={variant === "embedded"}
            height={variant === "modal" ? "min(720px, 85vh)" : variant === "popout" ? "100%" : undefined}
            onClose={variant === "modal" ? close : undefined}
            header={{
                title: "Radar",
                subtitle,
                live: activeRules > 0,
                iconNode: <AppIcon color="green"><RadarLogo size={24} spin={activeRules > 0} /></AppIcon>,
                actions: (
                    <RoundButton
                        icon={ICONS.gear}
                        label={tab === "options" ? "Back" : "Settings"}
                        active={tab === "options"}
                        onClick={() => setTab(tab === "options" ? "inbox" : "options")}
                    />
                )
            }}
            top={
                // No segment is selected while the settings (gear) are open
                <Segmented<TabId>
                    value={tab === "options" ? null : tab}
                    onChange={setTab}
                    options={[
                        { value: "inbox", label: "History", count: unread },
                        { value: "rules", label: "Rules" },
                        { value: "reminders", label: "Reminders", count: upcoming },
                        { value: "bookmarks", label: "Bookmarks" }
                    ]}
                />
            }
        >
            <div key={tab} className={cl("pane")}>
                {tab === "inbox" && <InboxTab />}
                {tab === "rules" && <RulesTab close={close} />}
                {tab === "reminders" && <RemindersTab close={close} />}
                {tab === "bookmarks" && <BookmarksTab />}
                {tab === "options" && <OptionsTab />}
            </div>
        </Sheet>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => <RadarApp variant="embedded" />, { noop: true });

export function openRadarModal() {
    openWindow(close => <RadarApp variant="modal" close={close} />);
}

// ---------------------------------------------------------------- Dialog: Reminder

function toLocalInput(ts: number) {
    const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000);
    return d.toISOString().slice(0, 16);
}

function ReminderDialog({ close, message }: { close(): void; message?: any; }) {
    const picks = useMemo(getQuickPicks, []);
    const [pick, setPick] = useState<string>(message ? picks[1].id : "custom");
    const [custom, setCustom] = useState(() => toLocalInput(Date.now() + 3600_000));
    const [note, setNote] = useState("");

    const due = pick === "custom" ? new Date(custom).getTime() : picks.find(p => p.id === pick)!.at();
    const invalid = !Number.isFinite(due) || due <= Date.now() || (!message && !note.trim());

    const save = () => {
        if (invalid) return;
        addReminder(due, note, message);
        close();
    };

    return (
        <Sheet
            onClose={close}
            header={{
                title: "Remind me…",
                subtitle: Number.isFinite(due) && due > Date.now() ? `${formatWhen(due)} (${formatRelative(due)})` : "Choose a time in the future",
                icon: RI.clock,
                iconColor: "green"
            }}
            actions={[
                { label: "Cancel", onClick: close, variant: "gray" },
                { label: "Remind", onClick: save, disabled: invalid }
            ]}
        >
            <div className={cl("form")}>
                {message && <SnapshotPreview m={snapshotMessage(message)} />}
                <Pills>
                    {picks.map(p => <Pill key={p.id} selected={pick === p.id} onClick={() => setPick(p.id)}>{p.label}</Pill>)}
                    <Pill selected={pick === "custom"} onClick={() => setPick("custom")}>Custom time…</Pill>
                </Pills>
                {pick === "custom" && (
                    <Field label="Date & time">
                        <TextField type="datetime-local" value={custom} onChange={setCustom} />
                    </Field>
                )}
                <Field label={message ? "Note (optional)" : "Note"}>
                    <TextArea
                        value={note}
                        rows={3}
                        maxLength={500}
                        placeholder={message ? "What should I remind you about?" : "e.g. Reply to Max"}
                        onChange={setNote}
                    />
                </Field>
            </div>
        </Sheet>
    );
}

export function openReminderModal(message?: any) {
    openWindow(close => <ReminderDialog close={close} message={message} />, { size: "small" });
}

// ---------------------------------------------------------------- Dialog: Bookmark

function BookmarkDialog({ close, message, existing }: { close(): void; message?: any; existing?: Bookmark; }) {
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
        close();
    };

    return (
        <Sheet
            onClose={close}
            header={{ title: existing ? "Edit bookmark" : "Save to Radar bookmarks", icon: RI.bookmark, iconColor: "green" }}
            actions={[
                ...(existing ? [{ label: "Remove", onClick: () => { deleteBookmark(existing.id); close(); }, variant: "destructive" as const }] : []),
                { label: "Cancel", onClick: close, variant: "gray" },
                { label: "Save", onClick: save }
            ]}
        >
            <div className={cl("form")}>
                {preview && <SnapshotPreview m={preview} />}
                <Section>
                    <ToggleRow
                        icon={ICONS.download}
                        color="blue"
                        checked={offline}
                        onChange={setOffline}
                        title={mediaCount ? `Save ${mediaCount === 1 ? "the image / video" : `all ${mediaCount} files`} on this PC` : "Save the avatar on this PC"}
                        subtitle={offline && existing?.offline
                            ? "Turning this off deletes the saved copies."
                            : "Stays in your bookmark even if the message or the account gets deleted."}
                    />
                </Section>
                <Field label="Tags (optional)" hint="Separate with commas, e.g. “important, recipes”">
                    <TextField value={tags} placeholder="important, read later" onChange={setTags} autoFocus />
                </Field>
                {known.length > 0 && (
                    <Pills>
                        {known.filter(t => !current.includes(t)).slice(0, 12).map(t => (
                            <Pill key={t} icon={ICONS.plus} onClick={() => setTags(current.concat(t).join(", "))}>#{t}</Pill>
                        ))}
                    </Pills>
                )}
                <Field label="Note (optional)">
                    <TextField value={note} maxLength={300} onChange={setNote} />
                </Field>
            </div>
        </Sheet>
    );
}

export function openBookmarkModal(message: any) {
    const existing = findBookmark(message.id);
    openWindow(close => existing
        ? <BookmarkDialog close={close} existing={existing} />
        : <BookmarkDialog close={close} message={message} />, { size: "small" });
}

function openBookmarkEditor(existing: Bookmark) {
    openWindow(close => <BookmarkDialog close={close} existing={existing} />, { size: "small" });
}

// ---------------------------------------------------------------- Dialog: picture / video viewer

function MediaViewer({ close, bookmarkId, start }: { close(): void; bookmarkId: string; start: number; }) {
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

    if (!b || !m) {
        return (
            <Sheet onClose={close} header={{ title: "Bookmark removed", icon: RI.image, iconColor: "green" }}>
                <Empty icon={RI.image} title="Not available anymore" />
            </Sheet>
        );
    }

    return (
        <Sheet
            onClose={close}
            header={{
                title: m.name,
                subtitle: `${b.message.authorName}${media.length > 1 ? ` · ${index + 1} of ${media.length}` : ""} · ${m.local ? "saved on this PC" : "from Discord, may disappear"}`,
                icon: m.kind === "video" ? ICONS.play : m.kind === "image" ? RI.image : RI.file,
                iconColor: "green"
            }}
            actions={[
                ...(b.offline ? [{ label: "Show in folder", onClick: () => openBookmarkFolder(b.id), variant: "gray" as const }] : []),
                { label: "Go to message", onClick: () => { close(); jumpTo(b.message); }, variant: "gray" },
                { label: "Close", onClick: close }
            ]}
        >
            <div className={cl("viewer")}>
                {media.length > 1 && <button type="button" className={classes(cl("viewer-nav"), cl("viewer-prev"))} aria-label="Previous" onClick={() => step(-1)}><Icon path={ICONS.back} size={22} /></button>}
                {!src
                    ? <span className={cl("dim")}>Loading…</span>
                    : broken
                        ? <Empty icon={RI.image} title="Not available anymore" hint="Discord no longer has this file and it wasn't saved on this PC." />
                        : m.kind === "image"
                            ? <img key={src} src={src} alt={m.name} onError={() => setBroken(true)} />
                            : m.kind === "video"
                                ? <video key={src} src={src} controls autoPlay onError={() => setBroken(true)} />
                                : (
                                    <Empty icon={RI.file} title={m.name} hint={m.size ? formatBytes(m.size) : undefined}>
                                        {b.offline && <Button icon={ICONS.folder} onClick={() => openBookmarkFolder(b.id)}>Show in folder</Button>}
                                    </Empty>
                                )}
                {media.length > 1 && <button type="button" className={classes(cl("viewer-nav"), cl("viewer-next"))} aria-label="Next" onClick={() => step(1)}><Icon path={ICONS.chevron} size={22} /></button>}
            </div>
        </Sheet>
    );
}

function openMediaViewer(bookmarkId: string, start: number) {
    openWindow(close => <MediaViewer close={close} bookmarkId={bookmarkId} start={start} />, { size: "large" });
}

// ---------------------------------------------------------------- Highlight under messages

export const HighlightChip = ErrorBoundary.wrap(({ message }: { message: any; }) => {
    useSignal(highlightSignal);
    const h = message?.id ? highlights.get(message.id) : undefined;
    if (!h) return null;
    return (
        <span className={cl("hl-chip")} style={{ "--vc-radar-hl": h.color } as CSSProperties}>
            <RadarLogo size={12} />
            <span>Radar · {h.ruleName}</span>
            <button type="button" className={cl("chip-x")} aria-label="Remove highlight" onClick={() => removeHighlight(message.id)}>
                <Icon path={ICONS.close} size={9} />
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
                    <Popover width={460} style={POPOUT_STYLE}>
                        <RadarApp variant="popout" close={() => setShow(false)} />
                    </Popover>
                </ErrorBoundary>
            )}
        >
            {(_, { isShown }) => (
                <HeaderBarIcon
                    ref={buttonRef}
                    className={classes(cl("tb"), unread > 0 && cl("tb-hot"))}
                    onClick={() => setShow(v => !v)}
                    tooltip={isShown ? null : unread ? `Radar – ${unread} unread` : "Radar"}
                    icon={() => (
                        <span className={cl("tb-icon")}>
                            <RadarLogo className="vc-ui-tb-icon" />
                            {unread > 0 && <span className={cl("tb-badge")}>{unread > 99 ? "99+" : unread}</span>}
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
