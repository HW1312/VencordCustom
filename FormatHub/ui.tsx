/*
 * FormatHub – UI: window with tabs (Mentions, Server Navigation, Timestamps, Emojis, Markdown,
 * Links, Decoder, Favorites), entries with live preview and the settings panel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { Switch } from "@components/Switch";
import { getCurrentChannel, getTheme, Theme } from "@utils/discord";
import { classes } from "@utils/misc";
import { IconComponent } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { findCssClassesLazy } from "@webpack";
import {
    ChannelStore, DraftStore, EmojiStore, GuildMemberStore, GuildRoleStore, GuildScheduledEventStore, GuildStore,
    Modal, openModal, Parser, SelectedChannelStore, showToast, Toasts, useMemo, UserStore, UserUtils, useState
} from "@webpack/common";
import type { ReactNode } from "react";

import {
    channelDisplayName, channelLink, DecodedToken, decodeText, emojiCdnUrl, emojiSyntax, eventLink, formatDate, FormatEntry, getRecentMessages,
    getSlashCommands, guildLink, inviteLink, messageLink, snowflakeToDate, TIMESTAMP_FLAGS, timestampSyntax, userDisplayName, userLink
} from "./formats";
import { copyFormat, insertFormat, MAX_RECENT, SavedFormat, settings, toggleFavorite } from "./index";

const cl = classNameFactory("vc-formathub-");
const MarkupClasses = findCssClassesLazy("markup", "codeContainer");

// ---------------------------------------------------------------- Icons

const ICONS = {
    hub: "M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4Zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4Z",
    copy: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
    insert: "M19 7v4H5.83l3.58-3.59L8 6l-6 6 6 6 1.41-1.41L5.83 13H21V7h-2z",
    star: "M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z",
    starOutline: "M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z",
    search: "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
    close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
    refresh: "M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
};

type IconName = keyof typeof ICONS;

function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden>
            <path fill="currentColor" d={ICONS[name]} />
        </svg>
    );
}

export const FormatHubIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg viewBox="0 0 24 24" width={width} height={height} className={className} aria-hidden>
        <path fill="currentColor" d={ICONS.hub} />
    </svg>
);

// ---------------------------------------------------------------- Context

interface HubContext {
    channel: Channel | undefined;
    guildId: string | null;
    close(): void;
}

// ---------------------------------------------------------------- Preview

function renderMarkdown(syntax: string, channelId: string | undefined): ReactNode {
    return Parser.parse(syntax, true, {
        channelId,
        viewingChannelId: SelectedChannelStore.getChannelId(),
        allowLinks: true,
        allowHeading: true,
        allowList: true,
        allowEmojiLinks: true
    });
}

function Preview({ syntax, channelId }: { syntax: string; channelId: string | undefined; }) {
    const rendered = useMemo(() => {
        try {
            return renderMarkdown(syntax, channelId);
        } catch {
            return syntax;
        }
    }, [syntax, channelId]);

    return (
        <ErrorBoundary noop>
            <div className={classes(MarkupClasses.markup, cl("preview"))}>{rendered}</div>
        </ErrorBoundary>
    );
}

// ---------------------------------------------------------------- Entry

function EntryRow({ entry, ctx, onRemove }: { entry: FormatEntry; ctx: HubContext; onRemove?(): void; }) {
    const { favorites } = settings.use(["favorites"]);
    const fav = favorites.some(f => f.syntax === entry.syntax);
    const saved: SavedFormat = { label: entry.label, syntax: entry.syntax };

    return (
        <div className={cl("entry")}>
            <div className={cl("entry-head")}>
                <span className={cl("entry-label")}>{entry.label}</span>
                {entry.hint && <span className={cl("entry-hint")}>{entry.hint}</span>}
                <div className={cl("entry-actions")}>
                    <button className={cl("btn")} onClick={() => copyFormat(saved)} title="Copy to clipboard">
                        <Icon name="copy" size={14} /> Copy
                    </button>
                    <button
                        className={classes(cl("btn"), cl("btn-brand"))}
                        title="Insert into the chat input"
                        onClick={() => {
                            if (insertFormat(saved) && settings.store.closeOnInsert) ctx.close();
                        }}
                    >
                        <Icon name="insert" size={14} /> Insert
                    </button>
                    {onRemove
                        ? (
                            <button className={classes(cl("icon-btn"))} onClick={onRemove} title="Remove from history">
                                <Icon name="close" size={16} />
                            </button>
                        )
                        : (
                            <button
                                className={classes(cl("icon-btn"), fav && cl("star-on"))}
                                onClick={() => toggleFavorite(saved)}
                                title={fav ? "Remove from favorites" : "Add to favorites"}
                            >
                                <Icon name={fav ? "star" : "starOutline"} size={18} />
                            </button>
                        )}
                </div>
            </div>
            <div className={cl("entry-body")}>
                <code className={cl("syntax")}>{entry.syntax}</code>
                <Preview syntax={entry.syntax} channelId={ctx.channel?.id} />
            </div>
        </div>
    );
}

function EntryList({ entries, ctx, empty }: { entries: FormatEntry[]; ctx: HubContext; empty?: string; }) {
    if (!entries.length) return <div className={cl("empty")}>{empty ?? "No entries"}</div>;
    return (
        <div className={cl("entries")}>
            {entries.map(e => <EntryRow key={e.label + e.syntax} entry={e} ctx={ctx} />)}
        </div>
    );
}

// ---------------------------------------------------------------- Building blocks

function SearchField({ value, onChange, placeholder }: { value: string; onChange(v: string): void; placeholder: string; }) {
    return (
        <div className={cl("search")}>
            <Icon name="search" size={16} />
            <input value={value} placeholder={placeholder} onChange={e => onChange(e.currentTarget.value)} spellCheck={false} />
            {value && (
                <button className={cl("icon-btn")} onClick={() => onChange("")} title="Clear">
                    <Icon name="close" size={14} />
                </button>
            )}
        </div>
    );
}

function TextField({ label, value, onChange, placeholder, mono }: { label: string; value: string; onChange(v: string): void; placeholder?: string; mono?: boolean; }) {
    return (
        <label className={cl("field")}>
            <span>{label}</span>
            <input className={classes(cl("input"), mono && cl("mono"))} value={value} placeholder={placeholder} spellCheck={false} onChange={e => onChange(e.currentTarget.value)} />
        </label>
    );
}

function Chips<T extends string>({ options, value, onChange }: { options: { value: T; label: string; count?: number; }[]; value: T; onChange(v: T): void; }) {
    return (
        <div className={cl("chips")}>
            {options.map(o => (
                <button key={o.value} className={classes(cl("chip"), o.value === value && cl("chip-active"))} onClick={() => onChange(o.value)}>
                    {o.label}{o.count != null && <span className={cl("chip-count")}>{o.count}</span>}
                </button>
            ))}
        </div>
    );
}

function Section({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode; }) {
    return (
        <div className={cl("section")}>
            <div className={cl("section-title")}>
                <span>{title}</span>
                {extra}
            </div>
            {children}
        </div>
    );
}

// ---------------------------------------------------------------- Real objects (Smart Fill)

type EntityKind = "user" | "role" | "channel" | "command" | "emoji" | "message" | "event";

interface Entity {
    kind: EntityKind;
    id: string;
    name: string;
    sub?: string;
    image?: string;
    color?: string;
    prefix?: string;
    /** Extra data, e.g. emoji animated / full command name */
    data?: any;
}

const CHANNEL_TYPES: Record<number, string> = {
    0: "Text channel", 1: "DM", 2: "Voice channel", 3: "Group", 4: "Category", 5: "Announcements",
    10: "Thread", 11: "Thread", 12: "Private thread", 13: "Stage", 15: "Forum", 16: "Media"
};

function collectUsers(guildId: string | null, channel: Channel | undefined): Entity[] {
    const ids = new Set<string>();
    const me = UserStore.getCurrentUser();
    if (me) ids.add(me.id);
    if (guildId) GuildMemberStore.getMemberIds(guildId).forEach(id => ids.add(id));
    channel?.recipients?.forEach(id => ids.add(id));
    if (!guildId) ChannelStore.getSortedPrivateChannels().forEach(c => c.recipients?.forEach(id => ids.add(id)));

    const result: Entity[] = [];
    for (const id of ids) {
        const user = UserStore.getUser(id);
        if (!user) continue;
        const name = userDisplayName(id, guildId) ?? user.username;
        result.push({
            kind: "user",
            id,
            name,
            sub: user.username + (user.bot ? " · Bot" : "") + (id === me?.id ? " · you" : ""),
            image: user.getAvatarURL(guildId, 32)
        });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
}

function collectRoles(guildId: string | null): Entity[] {
    if (!guildId) return [];
    return GuildRoleStore.getSortedRoles(guildId)
        .filter(r => r.id !== guildId)
        .map(r => ({
            kind: "role" as const,
            id: r.id,
            name: r.name,
            sub: r.managed ? "Integration" : r.mentionable ? "mentionable" : undefined,
            color: r.colorString,
            prefix: "@"
        }));
}

function collectChannels(guildId: string | null, channel: Channel | undefined): Entity[] {
    const channels: Channel[] = guildId
        ? [...Object.values(ChannelStore.getMutableGuildChannelsForGuild(guildId)), ...ChannelStore.getAllThreadsForGuild(guildId)]
        : ChannelStore.getSortedPrivateChannels();
    if (channel && !channels.some(c => c.id === channel.id)) channels.unshift(channel);

    return channels
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map(c => {
            const parent = c.parent_id ? ChannelStore.getChannel(c.parent_id) : null;
            return {
                kind: "channel" as const,
                id: c.id,
                name: channelDisplayName(c),
                sub: [CHANNEL_TYPES[c.type] ?? "Channel", parent?.name].filter(Boolean).join(" · "),
                prefix: c.isCategory?.() ? "▾" : "#"
            };
        });
}

function collectCommands(channel: Channel | undefined): Entity[] {
    return getSlashCommands(channel).map(c => ({
        kind: "command" as const,
        id: c.id,
        name: c.name,
        sub: [c.app, c.description].filter(Boolean).join(" · "),
        prefix: "/",
        data: c
    }));
}

function collectEmojis(guildId: string | null, all: boolean): Entity[] {
    const guilds = all || !guildId ? GuildStore.getGuildsArray().map(g => g.id) : [guildId];
    const result: Entity[] = [];
    for (const gid of guilds) {
        const guildName = GuildStore.getGuild(gid)?.name;
        for (const e of EmojiStore.getGuildEmoji(gid) ?? []) {
            result.push({
                kind: "emoji",
                id: e.id,
                name: e.name,
                sub: (e.animated ? "animated · " : "") + (guildName ?? ""),
                image: emojiCdnUrl(e.id, !!e.animated, 48),
                data: { animated: !!e.animated }
            });
        }
    }
    return result;
}

function collectMessages(channel: Channel | undefined): Entity[] {
    if (!channel) return [];
    return getRecentMessages(channel.id).map(m => ({
        kind: "message" as const,
        id: m.id,
        name: (m.content || (m.attachments?.length ? "[Attachment]" : m.embeds?.length ? "[Embed]" : "[no text]")).replace(/\s+/g, " ").slice(0, 90),
        sub: `${m.author?.username ?? "?"} · ${formatDate(snowflakeToDate(m.id) ?? new Date())}`,
        image: m.author?.getAvatarURL?.(channel.guild_id, 32)
    }));
}

function collectEvents(guildId: string | null): Entity[] {
    if (!guildId) return [];
    return GuildScheduledEventStore.getGuildScheduledEventsForGuild(guildId).map(e => ({
        kind: "event" as const,
        id: e.id,
        name: e.name,
        sub: formatDate(new Date(e.scheduled_start_time))
    }));
}

const PICKER_LIMIT = 60;

function EntityPicker({ items, selected, onSelect, placeholder, grid, emptyText }: {
    items: Entity[];
    selected: Partial<Record<EntityKind, string>>;
    onSelect(e: Entity): void;
    placeholder: string;
    grid?: boolean;
    emptyText?: string;
}) {
    const [query, setQuery] = useState("");
    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return items;
        return items.filter(i => i.id === q || i.name.toLowerCase().includes(q) || i.sub?.toLowerCase().includes(q));
    }, [items, query]);
    const shown = filtered.slice(0, grid ? PICKER_LIMIT * 2 : PICKER_LIMIT);

    return (
        <div className={cl("picker")}>
            <SearchField value={query} onChange={setQuery} placeholder={placeholder} />
            <div className={classes(cl("picker-list"), grid && cl("picker-grid"))}>
                {shown.map(item => (
                    <button
                        key={item.kind + item.id + item.name}
                        className={classes(cl("item"), selected[item.kind] === item.id && cl("item-selected"))}
                        onClick={() => onSelect(item)}
                        title={grid ? `:${item.name}: · ${item.sub ?? ""}` : item.id}
                    >
                        {item.image
                            ? <img className={grid ? cl("item-emoji") : cl("item-avatar")} src={item.image} alt="" loading="lazy" />
                            : <span className={cl("item-prefix")} style={item.color ? { color: item.color } : undefined}>{item.prefix}</span>}
                        {!grid && (
                            <span className={cl("item-text")}>
                                <span className={cl("item-name")} style={item.color ? { color: item.color } : undefined}>{item.name}</span>
                                {item.sub && <span className={cl("item-sub")}>{item.sub}</span>}
                            </span>
                        )}
                    </button>
                ))}
                {!shown.length && <div className={cl("empty")}>{items.length ? "No matches" : emptyText ?? "Nothing found"}</div>}
            </div>
            {filtered.length > shown.length && (
                <div className={cl("muted")}>… and {filtered.length - shown.length} more – refine your search</div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------- Selection (shared across all tabs)

interface Selection {
    user?: string;
    role?: string;
    channel?: string;
    emoji?: { id: string; name: string; animated: boolean; };
    message?: string;
    event?: string;
    cmdName: string;
    cmdGroup: string;
    cmdSub: string;
    cmdId: string;
}

type SetSelection = (patch: Partial<Selection>) => void;

function selectedIds(sel: Selection): Partial<Record<EntityKind, string>> {
    return { user: sel.user, role: sel.role, channel: sel.channel, emoji: sel.emoji?.id, message: sel.message, event: sel.event, command: sel.cmdId };
}

function applyEntity(e: Entity, set: SetSelection) {
    switch (e.kind) {
        case "user": return set({ user: e.id });
        case "role": return set({ role: e.id });
        case "channel": return set({ channel: e.id });
        case "message": return set({ message: e.id });
        case "event": return set({ event: e.id });
        case "emoji": return set({ emoji: { id: e.id, name: e.name, animated: !!e.data?.animated } });
        case "command": {
            const parts = e.name.split(" ");
            return set({
                cmdId: e.id,
                cmdName: parts[0] ?? "",
                cmdGroup: parts.length === 3 ? parts[1] : "",
                cmdSub: parts.length === 3 ? parts[2] : parts[1] ?? ""
            });
        }
    }
}

// ---------------------------------------------------------------- Tab: Mentions

type MentionKind = "all" | "user" | "role" | "channel" | "command";

function MentionsTab({ ctx, sel, set }: { ctx: HubContext; sel: Selection; set: SetSelection; }) {
    const [kind, setKind] = useState<MentionKind>("all");
    const users = useMemo(() => collectUsers(ctx.guildId, ctx.channel), [ctx.guildId]);
    const roles = useMemo(() => collectRoles(ctx.guildId), [ctx.guildId]);
    const channels = useMemo(() => collectChannels(ctx.guildId, ctx.channel), [ctx.guildId]);
    const commands = useMemo(() => collectCommands(ctx.channel), [ctx.channel?.id]);

    const items = kind === "user" ? users : kind === "role" ? roles : kind === "channel" ? channels : kind === "command" ? commands
        : [...users, ...roles, ...channels, ...commands];

    const userId = sel.user ?? UserStore.getCurrentUser()?.id ?? "USER_ID";
    const roleId = sel.role ?? roles[0]?.id ?? "ROLE_ID";
    const channelId = sel.channel ?? ctx.channel?.id ?? "CHANNEL_ID";
    const cmdName = sel.cmdName || "name";
    const cmdId = sel.cmdId || "COMMAND_ID";
    const cmdSub = sel.cmdSub || "subcommand";
    const cmdGroup = sel.cmdGroup || "group";

    const entries: FormatEntry[] = [
        { label: "User", syntax: `<@${userId}>`, hint: "Mentions the user (pings)" },
        { label: "Role", syntax: `<@&${roleId}>`, hint: ctx.guildId ? "Only pings if the role is mentionable" : "Roles only exist on servers" },
        { label: "Channel", syntax: `<#${channelId}>` },
        { label: "Everyone", syntax: "@everyone", hint: "Requires the \"Mention @everyone\" permission" },
        { label: "Everyone online", syntax: "@here" },
        { label: "Slash command", syntax: `</${cmdName}:${cmdId}>`, hint: "Clickable command" },
        { label: "Subcommand", syntax: `</${cmdName} ${cmdSub}:${cmdId}>` },
        { label: "Command group", syntax: `</${cmdName} ${cmdGroup} ${cmdSub}:${cmdId}>` }
    ];

    return (
        <div className={cl("split")}>
            <div className={cl("side")}>
                <Chips<MentionKind>
                    value={kind}
                    onChange={setKind}
                    options={[
                        { value: "all", label: "All" },
                        { value: "user", label: "Users", count: users.length },
                        { value: "role", label: "Roles", count: roles.length },
                        { value: "channel", label: "Channels", count: channels.length },
                        { value: "command", label: "Commands", count: commands.length }
                    ]}
                />
                <EntityPicker
                    items={items}
                    selected={selectedIds(sel)}
                    onSelect={e => applyEntity(e, set)}
                    placeholder="Search users, roles, channels or commands …"
                    emptyText={kind === "command" ? "No commands loaded – type \"/\" once in chat, then reopen" : undefined}
                />
                <Section title="Manual command">
                    <div className={cl("fields")}>
                        <TextField label="Name" value={sel.cmdName} onChange={v => set({ cmdName: v.replace(/^\//, "") })} placeholder="name" />
                        <TextField label="Group" value={sel.cmdGroup} onChange={v => set({ cmdGroup: v })} placeholder="optional" />
                        <TextField label="Subcommand" value={sel.cmdSub} onChange={v => set({ cmdSub: v })} placeholder="optional" />
                        <TextField label="ID" value={sel.cmdId} onChange={v => set({ cmdId: v.trim() })} placeholder="123…" mono />
                    </div>
                </Section>
            </div>
            <EntryList entries={entries} ctx={ctx} />
        </div>
    );
}

// ---------------------------------------------------------------- Tab: Server Navigation

function NavigationTab({ ctx, sel, set }: { ctx: HubContext; sel: Selection; set: SetSelection; }) {
    const roles = useMemo(() => collectRoles(ctx.guildId), [ctx.guildId]);
    const guild = ctx.guildId ? GuildStore.getGuild(ctx.guildId) : null;
    const roleId = sel.role ?? roles[0]?.id ?? "ROLE_ID";

    const entries: FormatEntry[] = [
        { label: "Channels & Roles", syntax: "<id:customize>", hint: "Onboarding questions / customize channels" },
        { label: "Browse channels", syntax: "<id:browse>" },
        { label: "Server guide", syntax: "<id:guide>", hint: "Only with the guide enabled" },
        { label: "Linked roles", syntax: "<id:linked-roles>" },
        { label: "Specific linked role", syntax: `<id:linked-roles:${roleId}>` },
        ...(guild ? [
            { label: "Server link", syntax: guildLink(guild.id), hint: guild.name },
            { label: "Server ID", syntax: guild.id }
        ] : [])
    ];

    return (
        <div className={cl("split")}>
            <div className={cl("side")}>
                <div className={cl("info")}>
                    These formats always work on the server the message is sent on – "id" is meant literally.
                </div>
                <EntityPicker
                    items={roles}
                    selected={selectedIds(sel)}
                    onSelect={e => applyEntity(e, set)}
                    placeholder="Search a role for linked role …"
                    emptyText="No roles (only available on servers)"
                />
            </div>
            <EntryList entries={entries} ctx={ctx} />
        </div>
    );
}

// ---------------------------------------------------------------- Tab: Timestamps

function toLocalInput(date: Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Convert Unix (s/ms), snowflake or date text to seconds */
function parseTimeInput(text: string): number | null {
    const t = text.trim();
    if (!t) return null;
    const ts = /^<t:(-?\d+)(?::\w)?>$/.exec(t);
    if (ts) return Number(ts[1]);
    if (/^\d{17,20}$/.test(t)) {
        const d = snowflakeToDate(t);
        return d ? Math.floor(d.getTime() / 1000) : null;
    }
    if (/^-?\d{1,11}$/.test(t)) return Number(t);
    if (/^\d{12,14}$/.test(t)) return Math.floor(Number(t) / 1000);
    const parsed = Date.parse(t);
    return isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

function atTime(daysAhead: number, hours: number, minutes = 0) {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(hours, minutes, 0, 0);
    return d;
}

function nextWeekday(weekday: number, hours: number) {
    const d = atTime(0, hours);
    const diff = (weekday - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return d;
}

const QUICK_TIMES: { label: string; get(): Date; }[] = [
    { label: "Now", get: () => new Date() },
    { label: "+15 min", get: () => new Date(Date.now() + 15 * 60_000) },
    { label: "+1 hr", get: () => new Date(Date.now() + 3_600_000) },
    { label: "Today 20:00", get: () => atTime(0, 20) },
    { label: "Tomorrow 09:00", get: () => atTime(1, 9) },
    { label: "Tomorrow 20:00", get: () => atTime(1, 20) },
    { label: "Midnight", get: () => atTime(1, 0) },
    { label: "Next Monday", get: () => nextWeekday(1, 9) },
    { label: "Next Friday 18:00", get: () => nextWeekday(5, 18) },
    { label: "+1 week", get: () => new Date(Date.now() + 7 * 86_400_000) }
];

function TimestampsTab({ ctx }: { ctx: HubContext; }) {
    const [unix, setUnix] = useState(() => Math.floor(Date.now() / 1000));
    const [raw, setRaw] = useState("");
    const date = new Date(unix * 1000);

    const setDate = (d: Date) => setUnix(Math.floor(d.getTime() / 1000));

    const entries: FormatEntry[] = TIMESTAMP_FLAGS.map(f => ({
        label: f.label,
        syntax: timestampSyntax(unix, f.flag),
        hint: f.flag ? `Flag ${f.flag}` : undefined
    }));
    entries.push({ label: "Unix time (seconds)", syntax: String(unix) });

    const parsedRaw = parseTimeInput(raw);

    return (
        <div className={cl("split")}>
            <div className={cl("side")}>
                <Section title="Date & time">
                    <input
                        type="datetime-local"
                        className={cl("input")}
                        value={toLocalInput(date)}
                        onChange={e => {
                            const d = new Date(e.currentTarget.value);
                            if (!isNaN(d.getTime())) setDate(d);
                        }}
                        style={{ colorScheme: getTheme() === Theme.Light ? "light" : "dark" }}
                    />
                    <div className={cl("muted")}>{formatDate(date)} · Unix {unix}</div>
                </Section>
                <Section title="Quick picks">
                    <div className={cl("quick")}>
                        {QUICK_TIMES.map(q => (
                            <button key={q.label} className={cl("chip")} onClick={() => setDate(q.get())}>{q.label}</button>
                        ))}
                    </div>
                </Section>
                <Section title="Use from value">
                    <SearchField value={raw} onChange={setRaw} placeholder="Unix time, snowflake ID, <t:…> or date" />
                    {raw && (
                        parsedRaw != null
                            ? (
                                <button className={classes(cl("btn"), cl("btn-brand"))} onClick={() => { setUnix(parsedRaw); setRaw(""); }}>
                                    Apply: {formatDate(new Date(parsedRaw * 1000))}
                                </button>
                            )
                            : <div className={cl("bad")}>Not recognized</div>
                    )}
                </Section>
            </div>
            <EntryList entries={entries} ctx={ctx} />
        </div>
    );
}

// ---------------------------------------------------------------- Tab: Emojis

function EmojisTab({ ctx, sel, set }: { ctx: HubContext; sel: Selection; set: SetSelection; }) {
    const [all, setAll] = useState(!ctx.guildId);
    const emojis = useMemo(() => collectEmojis(ctx.guildId, all), [ctx.guildId, all]);

    const emoji = sel.emoji ?? (emojis[0] ? { id: emojis[0].id, name: emojis[0].name, animated: !!emojis[0].data?.animated } : null);

    const entries: FormatEntry[] = emoji
        ? [
            { label: "Name", syntax: `:${emoji.name}:`, hint: "Only works if you are allowed to use the emoji" },
            { label: "Static emoji", syntax: emojiSyntax(emoji.name, emoji.id, false) },
            { label: "Animated emoji", syntax: emojiSyntax(emoji.name, emoji.id, true), hint: emoji.animated ? "This emoji is animated" : "Only for animated emojis" },
            { label: "Image URL", syntax: emojiCdnUrl(emoji.id, emoji.animated, 128) },
            { label: "Image URL (PNG, large)", syntax: `https://cdn.discordapp.com/emojis/${emoji.id}.png?size=512` },
            { label: "Emoji ID", syntax: emoji.id }
        ]
        : [
            { label: "Standard emoji", syntax: ":smile:", hint: "Unicode emojis by name" },
            { label: "Custom emoji", syntax: "<:name:EMOJI_ID>" },
            { label: "Animated emoji", syntax: "<a:name:EMOJI_ID>" }
        ];

    return (
        <div className={cl("split")}>
            <div className={cl("side")}>
                {ctx.guildId && (
                    <Chips<"guild" | "all">
                        value={all ? "all" : "guild"}
                        onChange={v => setAll(v === "all")}
                        options={[{ value: "guild", label: "This server" }, { value: "all", label: "All servers" }]}
                    />
                )}
                <EntityPicker
                    grid
                    items={emojis}
                    selected={selectedIds(sel)}
                    onSelect={e => applyEntity(e, set)}
                    placeholder="Search emojis …"
                    emptyText="No custom emojis found"
                />
                {emoji && <div className={cl("muted")}>Selected: :{emoji.name}: {emoji.animated ? "(animated)" : ""}</div>}
            </div>
            <EntryList entries={entries} ctx={ctx} />
        </div>
    );
}

// ---------------------------------------------------------------- Tab: Markdown

function MarkdownTab({ ctx }: { ctx: HubContext; }) {
    const [text, setText] = useState("Text");
    const [lang, setLang] = useState("js");
    const [url, setUrl] = useState("https://discord.com");
    const [filter, setFilter] = useState("");
    const t = text || "Text";

    const entries: FormatEntry[] = [
        { label: "Bold", syntax: `**${t}**` },
        { label: "Italic", syntax: `*${t}*` },
        { label: "Italic (underscore)", syntax: `_${t}_` },
        { label: "Bold & italic", syntax: `***${t}***` },
        { label: "Underline", syntax: `__${t}__` },
        { label: "Underline & italic", syntax: `__*${t}*__` },
        { label: "Strikethrough", syntax: `~~${t}~~` },
        { label: "Spoiler", syntax: `||${t}||` },
        { label: "Inline code", syntax: `\`${t}\`` },
        { label: "Code block", syntax: `\`\`\`${lang}\n${t}\n\`\`\``, hint: lang ? `Language: ${lang}` : undefined, block: true },
        { label: "Quote", syntax: `> ${t}` },
        { label: "Multi-line quote", syntax: `>>> ${t}\nSecond line`, block: true },
        { label: "Heading 1", syntax: `# ${t}`, block: true },
        { label: "Heading 2", syntax: `## ${t}`, block: true },
        { label: "Heading 3", syntax: `### ${t}`, block: true },
        { label: "Small text", syntax: `-# ${t}`, block: true },
        { label: "List", syntax: `- ${t}\n- Second item`, block: true },
        { label: "Nested list", syntax: `- ${t}\n  - Sub-item`, block: true },
        { label: "Numbered list", syntax: `1. ${t}\n2. Second item`, block: true },
        { label: "Masked link", syntax: `[${t}](${url})` },
        { label: "Masked link without embed", syntax: `[${t}](<${url}>)` },
        { label: "Link without embed", syntax: `<${url}>`, hint: "Suppresses the embed" },
        { label: "Escape", syntax: `\\*${t}\\*`, hint: "A backslash cancels formatting" },
        { label: "Escape emoji", syntax: "\\:smile:" }
    ];

    const q = filter.trim().toLowerCase();
    const shown = q ? entries.filter(e => e.label.toLowerCase().includes(q) || e.syntax.toLowerCase().includes(q)) : entries;

    return (
        <div className={cl("split")}>
            <div className={cl("side")}>
                <SearchField value={filter} onChange={setFilter} placeholder="Search formats (e.g. spoiler, list) …" />
                <Section title="Sample content">
                    <div className={cl("fields")}>
                        <TextField label="Text" value={text} onChange={setText} />
                        <TextField label="Code language" value={lang} onChange={setLang} placeholder="js, py, diff, ansi …" mono />
                        <TextField label="Link URL" value={url} onChange={setUrl} mono />
                    </div>
                </Section>
            </div>
            <EntryList entries={shown} ctx={ctx} empty="No format matches your search" />
        </div>
    );
}

// ---------------------------------------------------------------- Tab: Links

type LinkKind = "message" | "channel" | "event";

function LinksTab({ ctx, sel, set }: { ctx: HubContext; sel: Selection; set: SetSelection; }) {
    const [kind, setKind] = useState<LinkKind>("message");
    const [invite, setInvite] = useState("");
    const messages = useMemo(() => collectMessages(ctx.channel), [ctx.channel?.id]);
    const channels = useMemo(() => collectChannels(ctx.guildId, ctx.channel), [ctx.guildId]);
    const events = useMemo(() => collectEvents(ctx.guildId), [ctx.guildId]);

    const items = kind === "message" ? messages : kind === "channel" ? channels : events;
    const channelId = sel.channel ?? ctx.channel?.id;
    const channelGuild = channelId ? ChannelStore.getChannel(channelId)?.guild_id ?? ctx.guildId : ctx.guildId;
    const messageId = sel.message ?? messages[0]?.id;
    const eventId = sel.event ?? events[0]?.id;
    const code = invite.trim().replace(/^(?:https?:\/\/)?(?:discord\.gg|discord(?:app)?\.com\/invite)\//, "") || "INVITE_CODE";
    const userId = sel.user ?? UserStore.getCurrentUser()?.id;

    const entries: FormatEntry[] = [];
    if (ctx.channel && messageId) {
        const link = messageLink(ctx.guildId, ctx.channel.id, messageId);
        entries.push(
            { label: "Message link", syntax: link },
            { label: "Message without embed", syntax: `<${link}>` },
            { label: "Masked message link", syntax: `[go to message](${link})` }
        );
    }
    if (channelId) entries.push(
        { label: "Channel link", syntax: channelLink(channelGuild, channelId) },
        { label: "Channel link without embed", syntax: `<${channelLink(channelGuild, channelId)}>` }
    );
    if (ctx.guildId) entries.push({ label: "Server link", syntax: guildLink(ctx.guildId) });
    if (ctx.guildId && eventId) entries.push({ label: "Event link", syntax: eventLink(ctx.guildId, eventId) });
    entries.push({ label: "Invite", syntax: inviteLink(code), hint: invite ? undefined : "Enter a code below" });
    if (eventId) entries.push({ label: "Invite with event", syntax: `${inviteLink(code)}?event=${eventId}` });
    if (userId) entries.push({ label: "Profile link", syntax: userLink(userId), hint: userDisplayName(userId, ctx.guildId) ?? undefined });

    return (
        <div className={cl("split")}>
            <div className={cl("side")}>
                <Chips<LinkKind>
                    value={kind}
                    onChange={setKind}
                    options={[
                        { value: "message", label: "Messages", count: messages.length },
                        { value: "channel", label: "Channels", count: channels.length },
                        { value: "event", label: "Events", count: events.length }
                    ]}
                />
                <EntityPicker
                    items={items}
                    selected={selectedIds(sel)}
                    onSelect={e => applyEntity(e, set)}
                    placeholder={kind === "message" ? "Search messages in the current channel …" : kind === "channel" ? "Search channels …" : "Search events …"}
                    emptyText={kind === "message" ? "No loaded messages in this channel" : kind === "event" ? "No events on this server" : undefined}
                />
                <Section title="Invite">
                    <TextField label="Invite code or link" value={invite} onChange={setInvite} placeholder="e.g. abc123" mono />
                </Section>
            </div>
            <EntryList entries={entries} ctx={ctx} />
        </div>
    );
}

// ---------------------------------------------------------------- Tab: Decoder

function TokenRow({ token, onFetched }: { token: DecodedToken; onFetched(): void; }) {
    const [loading, setLoading] = useState(false);

    async function fetchUser(id: string) {
        setLoading(true);
        try {
            await UserUtils.getUser(id);
            onFetched();
        } catch {
            showToast("Could not load user – invalid or deleted ID", Toasts.Type.FAILURE);
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className={classes(cl("token"), cl(`token-${token.status}`))}>
            <span className={cl("token-kind")}>{token.kind}</span>
            <div className={cl("token-main")}>
                <span className={cl("token-title")}>{token.title}</span>
                {token.detail && <span className={cl("token-detail")}>{token.detail}</span>}
                <code className={cl("syntax")}>{token.raw}</code>
            </div>
            <div className={cl("entry-actions")}>
                {token.fetchUserId && (
                    <button className={cl("btn")} disabled={loading} onClick={() => fetchUser(token.fetchUserId!)}>
                        <Icon name="refresh" size={14} /> {loading ? "Loading …" : "Fetch"}
                    </button>
                )}
                <button className={cl("btn")} onClick={() => copyFormat({ label: token.kind, syntax: token.raw })}>
                    <Icon name="copy" size={14} /> Copy
                </button>
            </div>
        </div>
    );
}

function DecoderTab({ ctx }: { ctx: HubContext; }) {
    const [text, setText] = useState("");
    const [version, setVersion] = useState(0);
    const tokens = useMemo(() => decodeText(text, ctx.guildId), [text, ctx.guildId, version]);
    const bad = tokens.filter(t => t.status === "bad").length;

    function takeDraft() {
        if (!ctx.channel) return;
        const draft = DraftStore.getDraft(ctx.channel.id, 0);
        if (draft) setText(draft);
        else showToast("No draft in the chat input", Toasts.Type.MESSAGE);
    }

    return (
        <div className={cl("decoder")}>
            <div className={cl("decoder-input")}>
                <textarea
                    className={classes(cl("input"), cl("textarea"))}
                    value={text}
                    placeholder="Paste raw text, e.g. a copied message with <@123…>, <t:…>, links …"
                    spellCheck={false}
                    onChange={e => setText(e.currentTarget.value)}
                />
                <div className={cl("row")}>
                    <button className={cl("btn")} onClick={takeDraft} disabled={!ctx.channel}>Use draft</button>
                    <button className={cl("btn")} onClick={() => setText("")} disabled={!text}>Clear</button>
                    <span className={cl("muted")}>
                        {tokens.length} token{tokens.length === 1 ? "" : "s"} found{bad ? ` · ${bad} unknown/invalid` : ""}
                    </span>
                </div>
                {text && (
                    <Section title="Preview">
                        <Preview syntax={text} channelId={ctx.channel?.id} />
                    </Section>
                )}
            </div>
            <div className={cl("tokens")}>
                {tokens.map(t => <TokenRow key={t.index + t.raw} token={t} onFetched={() => setVersion(v => v + 1)} />)}
                {!tokens.length && <div className={cl("empty")}>{text ? "No Discord formats found in the text" : "Paste text on the left – every mention, emoji, timestamp and link is resolved here."}</div>}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Tab: Favorites

function FavoritesTab({ ctx }: { ctx: HubContext; }) {
    const { favorites, recent } = settings.use(["favorites", "recent"]);

    return (
        <div className={cl("columns")}>
            <Section
                title={`Favorites (${favorites.length})`}
                extra={favorites.length > 0 && (
                    <button className={cl("link-btn")} onClick={() => { settings.store.favorites = []; }}>Remove all</button>
                )}
            >
                <EntryList entries={favorites} ctx={ctx} empty="No favorites yet – click the star on a format." />
            </Section>
            <Section
                title={`Recently used (${recent.length}/${MAX_RECENT})`}
                extra={recent.length > 0 && (
                    <button className={cl("link-btn")} onClick={() => { settings.store.recent = []; }}>Clear history</button>
                )}
            >
                {recent.length
                    ? (
                        <div className={cl("entries")}>
                            {recent.map(r => (
                                <EntryRow
                                    key={r.syntax}
                                    entry={r}
                                    ctx={ctx}
                                    onRemove={() => { settings.store.recent = settings.store.recent.filter(x => x.syntax !== r.syntax); }}
                                />
                            ))}
                        </div>
                    )
                    : <div className={cl("empty")}>Copied or inserted formats appear here.</div>}
            </Section>
        </div>
    );
}

// ---------------------------------------------------------------- Window

const TABS = [
    { id: "mentions", label: "Mentions" },
    { id: "navigation", label: "Server Navigation" },
    { id: "timestamps", label: "Timestamps" },
    { id: "emojis", label: "Emojis" },
    { id: "markdown", label: "Markdown" },
    { id: "links", label: "Links" },
    { id: "decoder", label: "Decoder" },
    { id: "favorites", label: "Favorites" }
] as const;

type TabId = typeof TABS[number]["id"];

function HubContent({ ctx }: { ctx: HubContext; }) {
    const [tab, setTabState] = useState<TabId>(() => (TABS.some(t => t.id === settings.store.lastTab) ? settings.store.lastTab : "mentions") as TabId);
    const [sel, setSel] = useState<Selection>({ cmdName: "", cmdGroup: "", cmdSub: "", cmdId: "" });
    const set: SetSelection = patch => setSel(s => ({ ...s, ...patch }));
    const { favorites } = settings.use(["favorites"]);

    const setTab = (id: TabId) => {
        setTabState(id);
        settings.store.lastTab = id;
    };

    let content: ReactNode;
    switch (tab) {
        case "mentions": content = <MentionsTab ctx={ctx} sel={sel} set={set} />; break;
        case "navigation": content = <NavigationTab ctx={ctx} sel={sel} set={set} />; break;
        case "timestamps": content = <TimestampsTab ctx={ctx} />; break;
        case "emojis": content = <EmojisTab ctx={ctx} sel={sel} set={set} />; break;
        case "markdown": content = <MarkdownTab ctx={ctx} />; break;
        case "links": content = <LinksTab ctx={ctx} sel={sel} set={set} />; break;
        case "decoder": content = <DecoderTab ctx={ctx} />; break;
        case "favorites": content = <FavoritesTab ctx={ctx} />; break;
    }

    return (
        <div className={cl("hub")}>
            <div className={cl("tabs")} role="tablist">
                {TABS.map(t => (
                    <button
                        key={t.id}
                        role="tab"
                        aria-selected={t.id === tab}
                        className={classes(cl("tab"), t.id === tab && cl("tab-active"))}
                        onClick={() => setTab(t.id)}
                    >
                        {t.label}
                        {t.id === "favorites" && favorites.length > 0 && <span className={cl("chip-count")}>{favorites.length}</span>}
                    </button>
                ))}
            </div>
            <ErrorBoundary message="This tab could not be displayed.">
                <div className={cl("content")}>{content}</div>
            </ErrorBoundary>
        </div>
    );
}

function contextSubtitle(channel: Channel | undefined) {
    if (!channel) return "No channel selected";
    const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : null;
    return guild ? `${guild.name} · #${channelDisplayName(channel)}` : `Direct Message · ${channelDisplayName(channel)}`;
}

export function openFormatHub(channel?: Channel) {
    const ch = channel ?? getCurrentChannel();
    openModal(props => {
        const ctx: HubContext = {
            channel: ch,
            guildId: ch?.guild_id ?? null,
            close: props.onClose
        };
        return (
            <ErrorBoundary>
                <Modal {...props} size="xl" title="FormatHub" subtitle={contextSubtitle(ch)}>
                    <HubContent ctx={ctx} />
                </Modal>
            </ErrorBoundary>
        );
    });
}

// ---------------------------------------------------------------- Settings

function Option({ label, description, setting }: { label: string; description?: string; setting: "closeOnInsert" | "spaceAfterInsert" | "contextMenus" | "trackRecent"; }) {
    const value = settings.use([setting])[setting];
    return (
        <label className={cl("option")}>
            <span className={cl("option-text")}>
                <span>{label}</span>
                {description && <span className={cl("muted")}>{description}</span>}
            </span>
            <Switch checked={value} onChange={v => { settings.store[setting] = v; }} />
        </label>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => {
    const { favorites, recent } = settings.use(["favorites", "recent"]);

    return (
        <div className={cl("settings")}>
            <div className={cl("settings-hero")}>
                <FormatHubIcon width={28} height={28} />
                <div className={cl("option-text")}>
                    <span className={cl("settings-title")}>FormatHub</span>
                    <span className={cl("muted")}>Open the window via the button in the chat bar or here.</span>
                </div>
                <button className={classes(cl("btn"), cl("btn-brand"))} onClick={() => openFormatHub()}>Open</button>
            </div>

            <div className={cl("card")}>
                <Option label="Close window after inserting" setting="closeOnInsert" />
                <Option label="Space after inserting" description="So you can keep typing right away" setting="spaceAfterInsert" />
                <Option label="“Copy as format” in right-click menu" description="Users, roles, channels, servers, messages & emojis" setting="contextMenus" />
                <Option label="Remember recently used formats" description={`The last ${MAX_RECENT} copied/inserted formats`} setting="trackRecent" />
            </div>

            <div className={cl("card")}>
                <div className={cl("row")}>
                    <span>{favorites.length} favorites · {recent.length} in history</span>
                    <div className={cl("entry-actions")}>
                        <button className={cl("btn")} disabled={!recent.length} onClick={() => { settings.store.recent = []; }}>Clear history</button>
                        <button className={classes(cl("btn"), cl("btn-danger"))} disabled={!favorites.length} onClick={() => { settings.store.favorites = []; }}>Delete favorites</button>
                    </div>
                </div>
            </div>

            <div className={cl("muted")}>
                Tip: Slash commands only appear after Discord has loaded them (type "/" once in chat). Invalid or unknown IDs are marked red in the decoder.
            </div>
        </div>
    );
}, { noop: true });

