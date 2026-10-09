/*
 * MediaGallery – Vencord Userplugin
 * All images, videos and files of a channel as a grid – filter, view and download in bulk as a ZIP.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { ChannelStore, Menu } from "@webpack/common";

import { clearAll } from "./store";
import { GalleryIcon, openGallery, SettingsPanel } from "./ui";

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    showChatBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show button in the chat bar",
        default: true,
        hidden: true
    },
    showHeaderButton: {
        type: OptionType.BOOLEAN,
        description: "Show button in the channel header (also where you can't write)",
        default: true,
        hidden: true
    },
    autoLoad: {
        type: OptionType.BOOLEAN,
        description: "Automatically scan the latest 100 messages on open",
        default: true,
        hidden: true
    },
    showEmbeds: {
        type: OptionType.BOOLEAN,
        description: "Show link embeds by default",
        default: true,
        hidden: true
    },
    pagesPerClick: {
        type: OptionType.NUMBER,
        description: "Pages (of 100 messages) per click on \"Load more\"",
        default: 10,
        hidden: true
    },
    thumbSize: {
        type: OptionType.NUMBER,
        description: "Thumbnail size (px)",
        default: 150,
        hidden: true
    },
    zipWarnMb: {
        type: OptionType.NUMBER,
        description: "Warn before ZIP downloads above (MB)",
        default: 500,
        hidden: true
    }
});

// ---------------------------------------------------------------- Entry points

/** Categories, forums and media channels have no messages of their own */
const NO_MESSAGES = new Set([4, 15, 16]);

const channelContext: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel || NO_MESSAGES.has(channel.type)) return;

    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;
    group.push(
        <Menu.MenuItem
            id="vc-mediagallery-open"
            label="Media Gallery"
            icon={GalleryIcon}
            action={() => openGallery(channel)}
        />
    );
};

const userContext: NavContextMenuPatchCallback = (children, props) => {
    // Only in DM context (right-click on a DM entry)
    if (!props?.channel?.isDM?.()) return;
    channelContext(children, props);
};

/** Right-click on a message: gallery of the channel it is in */
const messageContext: NavContextMenuPatchCallback = (children, { message }) => {
    const channel = message?.channel_id ? ChannelStore.getChannel(message.channel_id) : null;
    if (!channel || NO_MESSAGES.has(channel.type)) return;

    const item = (
        <Menu.MenuItem
            id="vc-mediagallery-open"
            label="Media Gallery"
            icon={GalleryIcon}
            action={() => openGallery(channel)}
        />
    );
    const group = findGroupChildrenByChildId("copy-link", children);
    if (group) group.push(item);
    else children.push(<Menu.MenuGroup>{item}</Menu.MenuGroup>);
};

const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

/** Channel header: always visible, unlike the chat bar button which needs write permission */
function HeaderButton({ channel }: { channel: any; }) {
    const { showHeaderButton } = settings.use(["showHeaderButton"]);
    if (!showHeaderButton || !channel?.id || NO_MESSAGES.has(channel.type)) return null;
    return (
        <HeaderBarIcon
            className="vc-mediagallery-header-btn"
            tooltip="Media Gallery"
            icon={() => <GalleryIcon width={20} height={20} />}
            onClick={() => openGallery(channel)}
        />
    );
}

const ChatButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    const { showChatBarButton } = settings.use(["showChatBarButton"]);
    if (!showChatBarButton || !isMainChat || !channel) return null;

    return (
        <ChatBarButton tooltip="Media Gallery" onClick={() => openGallery(channel)}>
            <GalleryIcon width={20} height={20} />
        </ChatBarButton>
    );
};

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "MediaGallery",
    description: "All images, videos and files of a channel as a grid: filter, view in the lightbox and download as a ZIP",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Media", "Chat", "Utility"],
    settings,

    patches: [
        {
            // Header of every chat (DM, channel, thread)
            find: "Missing channel in Channel.renderHeaderToolbar",
            replacement: {
                match: /this\.renderHeaderToolbar\(\)/,
                replace: "$self.wrapToolbar($&,this?.props?.channel)"
            }
        }
    ],

    wrapToolbar(toolbar: any, channel: any) {
        const button = <ErrorBoundary noop key="vc-mediagallery-toolbar"><HeaderButton channel={channel} /></ErrorBoundary>;
        return Array.isArray(toolbar) ? [button, ...toolbar] : [button, toolbar];
    },

    contextMenus: {
        "message": messageContext,
        "channel-context": channelContext,
        "thread-context": channelContext,
        "gdm-context": channelContext,
        "user-context": userContext
    },

    chatBarButton: {
        icon: GalleryIcon,
        render: ChatButton
    },

    stop() {
        // Cancel running loads, discard session cache
        clearAll();
    }
});
