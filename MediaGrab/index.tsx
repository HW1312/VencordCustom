/*
 * MediaGrab – Vencord Userplugin
 * Turns TikTok / YouTube / Instagram / X / Reddit … links into a video or MP3: right-click a message with a link,
 * or use the button in the chat bar. The file lands in your message box and/or the Downloads folder.
 * Downloads run through yt-dlp (+ ffmpeg), which is installed on first use.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { MessageSendListener } from "@api/MessageEvents";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, ComponentDispatch, FluxDispatcher, Menu } from "@webpack/common";

import { grab, GrabRequest } from "./grab";
import { settings } from "./settings";
import { askLinkChoice, ChatBarIcon, chatBarTooltip, GrabIcon, openGrabModal, useRunning } from "./ui";

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

/** Sites where a link usually is one video – other links (articles, profiles …) are sent without asking */
const MEDIA_LINKS: [host: RegExp, path: RegExp][] = [
    [/(^|\.)tiktok\.com$/, /./],
    [/(^|\.)youtube\.com$/, /^\/(watch|shorts\/|live\/)/],
    [/^youtu\.be$/, /^\/./],
    [/(^|\.)instagram\.com$/, /^\/(p|reels?|tv)\//],
    [/(^|\.)(x|twitter|fxtwitter|vxtwitter|fixupx)\.com$/, /\/status\/\d+/],
    [/(^|\.)reddit\.com$/, /\/(comments|s)\//],
    [/(^|\.)redd\.it$/, /^\/./],
    [/^clips\.twitch\.tv$/, /^\/./],
    [/(^|\.)twitch\.tv$/, /(^\/videos\/|\/clip\/)/],
    [/(^|\.)soundcloud\.com$/, /^\/[^/]+\/[^/]+/],
    [/(^|\.)vimeo\.com$/, /^\/\d+/],
    [/(^|\.)facebook\.com$/, /(\/videos?\/|\/reel\/|^\/watch)/],
    [/^fb\.watch$/, /^\/./],
    [/(^|\.)streamable\.com$/, /^\/./],
    [/(^|\.)threads\.(net|com)$/, /\/post\//],
    [/^bsky\.app$/, /\/post\//]
];

/** True if the text is nothing but one link to a video (a link in <…> means "no preview" – that stays a link) */
function isMediaLink(text: string) {
    if (!/^https?:\/\/\S+$/i.test(text)) return false;
    try {
        const u = new URL(text);
        const host = u.hostname.replace(/^(www|m|vm|vt)\./, "");
        return MEDIA_LINKS.some(([h, p]) => h.test(host) && p.test(u.pathname));
    } catch {
        return false;
    }
}

const onBeforeSend: MessageSendListener = async (channelId, msg, options, props) => {
    if (!settings.store.askOnLinkSend || props.hasAttachments || props.hasStickers) return;
    const url = msg.content.trim();
    if (!isMediaLink(url)) return;

    const choice = await askLinkChoice(url);
    if (choice?.kind === "link") return;
    // Closed → don't send, the link stays in the message box
    if (!choice) return { cancel: true };

    const channel = props.channel ?? ChannelStore.getChannel(channelId);
    const maxHeight = choice.kind === "video" ? choice.quality : 0;
    grab({ url, kind: choice.kind, maxHeight, toChat: true, toDisk: false, channel, sendNow: true, reply: options.messageReference });

    // Discord keeps the text after a cancelled send – empty the box and drop the reply bar
    setTimeout(() => {
        ComponentDispatch.dispatchToLastSubscribed("CLEAR_TEXT");
        if (options.messageReference) FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
    }, 0);
    return { cancel: true };
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

    onBeforeMessageSend: onBeforeSend,

    chatBarButton: {
        icon: GrabIcon,
        render: ChatButton
    }
});
