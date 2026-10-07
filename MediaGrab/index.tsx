/*
 * MediaGrab – Vencord Userplugin
 * Turns TikTok / YouTube / Instagram / X / Reddit … links into a video or MP3: right-click a message with a link,
 * or use the button in the chat bar. The file lands in your message box and/or the Downloads folder.
 * Downloads run through yt-dlp (+ ffmpeg), which is installed on first use.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, Menu } from "@webpack/common";

import { grab, GrabRequest } from "./grab";
import { settings } from "./settings";
import { ChatBarIcon, chatBarTooltip, GrabIcon, openGrabModal, useRunning } from "./ui";

const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"\]]/gi;

/** Links in a message: the text first, then embeds (e.g. a TikTok preview) */
function messageLinks(message: Message) {
    const links = new Set<string>();
    for (const m of message.content?.match(URL_RE) ?? []) links.add(m);
    for (const e of message.embeds ?? []) if ((e as any).url) links.add((e as any).url);
    return [...links].filter(l => !/^https?:\/\/(discord\.com|discord\.gg|discordapp\.com)\//i.test(l));
}

const messageContext: NavContextMenuPatchCallback = (children, { message, channel, itemHref }) => {
    if (!message) return;
    const links = messageLinks(message);
    const href: string | undefined = typeof itemHref === "string" && /^https?:\/\//i.test(itemHref) ? itemHref : undefined;
    if (href && !links.includes(href)) links.unshift(href);
    if (!links.length) return;

    const url = href ?? links[0];
    const chan = channel ?? ChannelStore.getChannel(message.channel_id);
    const quick = (kind: GrabRequest["kind"], toChat: boolean) =>
        grab({ url, kind, maxHeight: settings.store.menuQuality, toChat, toDisk: !toChat, channel: chan });

    const group = findGroupChildrenByChildId("copy-link", children) ?? children;
    group.push(
        <Menu.MenuItem id="vc-mediagrab" label="MediaGrab" icon={GrabIcon}>
            <Menu.MenuItem id="vc-mediagrab-video-chat" label="Video into the chat" action={() => quick("video", true)} />
            <Menu.MenuItem id="vc-mediagrab-audio-chat" label="MP3 into the chat" action={() => quick("audio", true)} />
            <Menu.MenuSeparator />
            <Menu.MenuItem id="vc-mediagrab-video-disk" label="Save video" action={() => quick("video", false)} />
            <Menu.MenuItem id="vc-mediagrab-audio-disk" label="Save as MP3" action={() => quick("audio", false)} />
            <Menu.MenuSeparator />
            <Menu.MenuItem id="vc-mediagrab-more" label="More options …" action={() => openGrabModal(chan, links)} />
        </Menu.MenuItem>
    );
};

const ChatButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    const { showChatBarButton } = settings.use(["showChatBarButton"]);
    const { count, progress } = useRunning();
    if (!showChatBarButton || !isMainChat) return null;

    return (
        <ChatBarButton tooltip={chatBarTooltip(count, progress)} onClick={() => openGrabModal(channel)}>
            <ChatBarIcon />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "MediaGrab",
    description: "Paste a TikTok / YouTube / Instagram … link and get the video or MP3, right into the chat or your Downloads folder",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Media", "Chat", "Utility"],
    settings,

    contextMenus: {
        "message": messageContext
    },

    chatBarButton: {
        icon: GrabIcon,
        render: ChatButton
    }
});
