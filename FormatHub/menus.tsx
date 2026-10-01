/*
 * FormatHub – right-click menus "Copy as format" (user, channel, role, server, message, emoji)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import type { Channel, Guild, Message, Role, User } from "@vencord/discord-types";
import { EmojiStore, GuildRoleStore, Menu, SelectedGuildStore } from "@webpack/common";

import { channelLink, emojiCdnUrl, emojiSyntax, FormatEntry, guildLink, messageLink, timestampSyntax, userLink } from "./formats";
import { copyFormat, settings } from "./index";

// ---------------------------------------------------------------- Build

function truncate(text: string, max = 46) {
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function buildMenu(key: string, entries: FormatEntry[]) {
    return (
        <Menu.MenuItem id={`vc-formathub-${key}`} key={`vc-formathub-${key}`} label="Copy as format">
            {entries.map((entry, i) => (
                <Menu.MenuItem
                    key={i}
                    id={`vc-formathub-${key}-${i}`}
                    label={entry.label}
                    subtext={truncate(entry.syntax)}
                    action={() => copyFormat(entry)}
                />
            ))}
        </Menu.MenuItem>
    );
}

function add(children: Array<React.ReactElement<any> | null>, key: string, entries: FormatEntry[]) {
    if (!settings.store.contextMenus || !entries.length) return;
    children.push(<Menu.MenuSeparator key={`vc-formathub-${key}-sep`} />, buildMenu(key, entries));
}

// ---------------------------------------------------------------- Entries

function userEntries(user: User): FormatEntry[] {
    return [
        { label: "Mention", syntax: `<@${user.id}>` },
        { label: "User ID", syntax: user.id },
        { label: "Profile link", syntax: userLink(user.id) },
        { label: "Profile link without embed", syntax: `<${userLink(user.id)}>` },
        { label: "Username", syntax: user.username }
    ];
}

function channelEntries(channel: Channel): FormatEntry[] {
    const link = channelLink(channel.guild_id, channel.id);
    return [
        { label: "Channel mention", syntax: `<#${channel.id}>` },
        { label: "Channel ID", syntax: channel.id },
        { label: "Channel link", syntax: link },
        { label: "Link without embed", syntax: `<${link}>` }
    ];
}

function roleEntries(role: Role): FormatEntry[] {
    return [
        { label: "Role mention", syntax: `<@&${role.id}>` },
        { label: "Role ID", syntax: role.id },
        { label: "Role name", syntax: role.name },
        ...(role.colorString ? [{ label: "Color", syntax: role.colorString }] : [])
    ];
}

function guildEntries(guild: Guild): FormatEntry[] {
    return [
        { label: "Server ID", syntax: guild.id },
        { label: "Server link", syntax: guildLink(guild.id) },
        { label: "Channels & Roles", syntax: "<id:customize>" },
        { label: "Browse channels", syntax: "<id:browse>" },
        { label: "Server guide", syntax: "<id:guide>" },
        { label: "Linked roles", syntax: "<id:linked-roles>" }
    ];
}

function messageEntries(message: Message, guildId: string | null | undefined): FormatEntry[] {
    const link = messageLink(guildId, message.channel_id, message.id);
    const unix = Math.floor(new Date(message.timestamp as any).getTime() / 1000);
    const entries: FormatEntry[] = [
        { label: "Message link", syntax: link },
        { label: "Link without embed", syntax: `<${link}>` },
        { label: "Masked link", syntax: `[Message](${link})` },
        { label: "Message ID", syntax: message.id },
        { label: "Channel mention", syntax: `<#${message.channel_id}>` }
    ];
    if (message.author) entries.push({ label: "Mention author", syntax: `<@${message.author.id}>` });
    if (!isNaN(unix)) entries.push(
        { label: "Timestamp (date & time)", syntax: timestampSyntax(unix, "f") },
        { label: "Timestamp (relative)", syntax: timestampSyntax(unix, "R") }
    );
    return entries;
}

function emojiEntries(id: string, name: string, animated: boolean): FormatEntry[] {
    return [
        { label: "Emoji syntax", syntax: emojiSyntax(name, id, animated) },
        { label: "Emoji name", syntax: `:${name}:` },
        { label: "Emoji ID", syntax: id },
        { label: "Image URL", syntax: emojiCdnUrl(id, animated, 128) }
    ];
}

/** Resolve emoji name from store, message text or reactions */
function resolveEmoji(id: string, message?: Message, href?: string) {
    const stored = EmojiStore.getCustomEmojiById(id);
    if (stored) return { name: stored.name, animated: !!stored.animated };

    const match = message?.content?.match(new RegExp(`<(a?):(\\w+):${id}>`));
    if (match) return { name: match[2], animated: !!match[1] };

    const reaction = (message as any)?.reactions?.find((r: any) => r?.emoji?.id === id);
    if (reaction?.emoji?.name) return { name: reaction.emoji.name, animated: !!reaction.emoji.animated };

    let urlName: string | null = null;
    try { urlName = href ? new URL(href).searchParams.get("name") : null; } catch { /* not a URL */ }
    return { name: urlName ?? "emoji", animated: !!href && /\.gif|animated=true/.test(href) };
}

// ---------------------------------------------------------------- Patches

const userPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (user) add(children, "user", userEntries(user));
};

const channelPatch: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    if (channel) add(children, "channel", channelEntries(channel));
};

const guildPatch: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    if (guild) add(children, "guild", guildEntries(guild));
};

const roleSettingsPatch: NavContextMenuPatchCallback = (children, { role }: { role?: Role; }) => {
    if (role) add(children, "role", roleEntries(role));
};

/** Roles in profile & member list (developer mode menu with the role ID) */
const devPatch: NavContextMenuPatchCallback = (children, { id }: { id?: string; }) => {
    const guildId = SelectedGuildStore.getGuildId();
    if (!id || !guildId) return;
    const role = GuildRoleStore.getRole(guildId, id);
    if (role) add(children, "role", roleEntries(role));
};

const messagePatch: NavContextMenuPatchCallback = (children, props: { message?: Message; channel?: Channel; favoriteableId?: string; favoriteableType?: string; itemHref?: string; itemSrc?: string; }) => {
    const { message, channel, favoriteableId, favoriteableType, itemHref, itemSrc } = props ?? {};
    if (!message) return;

    if (favoriteableType === "emoji" && favoriteableId) {
        const { name, animated } = resolveEmoji(favoriteableId, message, itemHref ?? itemSrc);
        add(children, "emoji", emojiEntries(favoriteableId, name, animated));
    }

    const guildId = channel?.guild_id ?? SelectedGuildStore.getGuildId();
    add(children, "message", messageEntries(message, guildId));
};

const expressionPickerPatch: NavContextMenuPatchCallback = (children, { target }: { target?: HTMLElement; }) => {
    const { id, name, type } = target?.dataset ?? {};
    if (type !== "emoji" || !id || !name) return;
    const img = target?.firstChild as HTMLImageElement | null;
    const animated = EmojiStore.getCustomEmojiById(id)?.animated ?? /\.gif|animated=true/.test(img?.src ?? "");
    add(children, "emoji", emojiEntries(id, name.replace(/~\d+$/, ""), !!animated));
};

export const contextMenus: Record<string, NavContextMenuPatchCallback> = {
    "user-context": userPatch,
    "channel-context": channelPatch,
    "thread-context": channelPatch,
    "gdm-context": channelPatch,
    "guild-context": guildPatch,
    "guild-settings-role-context": roleSettingsPatch,
    "dev-context": devPatch,
    "message": messagePatch,
    "expression-picker": expressionPickerPatch
};
