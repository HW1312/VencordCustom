/*
 * ChatPopout – Vencord Userplugin
 * Open DMs, groups, channels and voice chats in their own windows – optionally together with the call window.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { getCurrentChannel } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, Menu, PopoutActions, PopoutWindowStore, SelectedChannelStore, showToast, Toasts, Tooltip } from "@webpack/common";

import { ChatWindow, Icon, POPOUT_PATH } from "./chat";
import { emitChannelEvent } from "./messages";

export const logger = new Logger("ChatPopout");

/** Discord only opens windows whose key starts with "DISCORD_" as proper Discord windows */
const KEY_PREFIX = "DISCORD_VC_CHATPOPOUT_";

export const settings = definePluginSettings({
    alwaysOnTop: {
        type: OptionType.BOOLEAN,
        description: "Open new windows always on top",
        default: false
    },
    shortcut: {
        type: OptionType.BOOLEAN,
        description: "Ctrl + Shift + P opens the current chat in its own window",
        default: true
    },
    listButtons: {
        type: OptionType.BOOLEAN,
        description: "Show popout icon when hovering DMs and channels",
        default: true
    },
    headerButton: {
        type: OptionType.BOOLEAN,
        description: "Show popout icon in the header of every chat",
        default: true
    },
    chatBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show button in the chat bar",
        default: true
    },
    showTyping: {
        type: OptionType.BOOLEAN,
        description: "Show who is typing",
        default: true
    },
    sidebar: {
        type: OptionType.BOOLEAN,
        description: "Show the channel list on the left side of popout windows (toggle with the button in the title bar)",
        default: true
    },
    showVoice: {
        type: OptionType.BOOLEAN,
        description: "Show a bar with the people in the call",
        default: true
    },
    voiceListOpen: {
        type: OptionType.BOOLEAN,
        description: "Call bar expanded to a list",
        default: false,
        hidden: true
    }
});

// ---------------------------------------------------------------- Windows

export const windowKey = (channelId: string) => KEY_PREFIX + channelId;

export function isInCall(channelId: string) {
    return SelectedChannelStore.getVoiceChannelId() === channelId;
}

export function openChatPopout(channelId: string | null | undefined) {
    const channel = channelId ? ChannelStore.getChannel(channelId) : null;
    if (!channel) {
        showToast("This chat can't be opened", Toasts.Type.FAILURE);
        return;
    }

    const key = windowKey(channel.id);
    const alreadyOpen = PopoutWindowStore.getWindowOpen(key);

    try {
        PopoutActions.open(key, k => <ChatWindow channelId={channel.id} windowKey={k} />, {
            defaultWidth: settings.store.sidebar ? 680 : 440,
            defaultHeight: 680,
            defaultAlwaysOnTop: settings.store.alwaysOnTop
        });
    } catch (e) {
        logger.error("Couldn't open window", e);
        showToast("Couldn't open window", Toasts.Type.FAILURE);
        return;
    }

    // Apply the default on first open (afterwards Discord remembers the state itself)
    if (!alreadyOpen && settings.store.alwaysOnTop && !PopoutWindowStore.getIsAlwaysOnTop(key)) {
        setTimeout(() => PopoutActions.setAlwaysOnTop(key, true), 600);
    }
}

/** Discord's own call window (tiles, camera, stream) */
export function openCallPopout(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;
    if (!isInCall(channelId)) {
        showToast("You're not in a call in this channel", Toasts.Type.FAILURE);
        return;
    }
    FluxDispatcher.dispatch({ type: "CHANNEL_CALL_POPOUT_WINDOW_OPEN", channel } as any);
}

export function openCallAndChat(channelId: string) {
    openCallPopout(channelId);
    // Wait briefly so the two windows don't steal each other's focus
    setTimeout(() => openChatPopout(channelId), 400);
}

function closeAll() {
    for (const key of PopoutWindowStore.getWindowKeys?.() ?? []) {
        if (key.startsWith(KEY_PREFIX)) PopoutActions.close(key);
    }
}

// ---------------------------------------------------------------- Menus

function menuItems(channelId: string) {
    const items = [
        <Menu.MenuItem
            key="vc-chatpopout"
            id="vc-chatpopout"
            label="Open in New Window"
            icon={() => <Icon path={POPOUT_PATH} size={18} />}
            action={() => openChatPopout(channelId)}
        />
    ];
    if (isInCall(channelId)) {
        items.push(
            <Menu.MenuItem
                key="vc-chatpopout-call"
                id="vc-chatpopout-call"
                label="Pop Out Call & Chat"
                action={() => openCallAndChat(channelId)}
            />
        );
    }
    return items;
}

function append(children: Array<any>, channelId: string | undefined) {
    if (!channelId) return;
    children.push(<Menu.MenuSeparator key="vc-chatpopout-sep" />, ...menuItems(channelId));
}

/** Right-click on a user: only if a DM with them already exists */
const userContext: NavContextMenuPatchCallback = (children, { user }: { user?: { id: string; }; }) => {
    if (!user) return;
    append(children, ChannelStore.getDMFromUserId(user.id));
};

/** Right-click on a channel, voice channel, thread or group DM */
const channelContext: NavContextMenuPatchCallback = (children, { channel }: { channel?: { id: string; }; }) => {
    append(children, channel?.id);
};

// ---------------------------------------------------------------- Chat bar button

const PopoutChatButton: ChatBarButtonFactory = ({ channel, isAnyChat }) => {
    const { chatBarButton } = settings.use(["chatBarButton"]);
    if (!isAnyChat || !chatBarButton || !channel) return null;

    return (
        <ChatBarButton tooltip="Open in New Window" onClick={() => openChatPopout(channel.id)}>
            <Icon path={POPOUT_PATH} size={20} />
        </ChatBarButton>
    );
};

// ---------------------------------------------------------------- Popout icons in lists & header

type ChannelLike = { id: string; isGuildVoice?(): boolean; isGuildStageVoice?(): boolean; } | null | undefined;

const isVoice = (c: ChannelLike) => !!(c?.isGuildVoice?.() || c?.isGuildStageVoice?.());

function stop(e: React.SyntheticEvent) {
    e.preventDefault();
    e.stopPropagation();
}

/** Small icon that appears when hovering a list entry */
function RowButton({ channel }: { channel: ChannelLike; }) {
    const { listButtons } = settings.use(["listButtons"]);
    if (!listButtons || !channel?.id) return null;
    return (
        <Tooltip text="Open in New Window">
            {({ onMouseEnter, onMouseLeave }) => (
                <button
                    className="vc-chatpopout-row-btn"
                    aria-label="Open in New Window"
                    onMouseEnter={onMouseEnter}
                    onMouseLeave={onMouseLeave}
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => {
                        stop(e);
                        onMouseLeave?.();
                        openChatPopout(channel.id);
                    }}
                >
                    <Icon path={POPOUT_PATH} size={16} />
                </button>
            )}
        </Tooltip>
    );
}

const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

function ToolbarButton({ channel }: { channel: ChannelLike; }) {
    const { headerButton } = settings.use(["headerButton"]);
    if (!headerButton || !channel?.id) return null;
    return (
        <HeaderBarIcon
            className="vc-chatpopout-header-btn"
            tooltip="Open in New Window"
            icon={() => <Icon path={POPOUT_PATH} size={20} />}
            onClick={() => openChatPopout(channel.id)}
        />
    );
}

// ---------------------------------------------------------------- Keyboard shortcut

function onKeyDown(e: KeyboardEvent) {
    if (!settings.store.shortcut) return;
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.code !== "KeyP") return;
    e.preventDefault();
    e.stopPropagation();
    openChatPopout(getCurrentChannel()?.id);
}

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "ChatPopout",
    description: "Open DMs, channels and voice chats in their own windows – optionally together with the call window and always on top.",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Chat", "Utility", "Voice"],
    settings,

    patches: [
        {
            // DM list: icon next to the "Close DM" cross
            find: "PrivateChannel.renderAvatar",
            noWarn: true,
            replacement: {
                match: /#{intl::CLOSE_DM}.+?}\)(?=])/,
                replace: "$&,$self.renderRowButton(arguments[0]?.channel)"
            }
        },
        {
            // Text channels in the server list: icon before "Edit"
            find: 'tutorialId:"instant-invite"',
            noWarn: true,
            replacement: {
                match: /this\.renderEditButton\(\)/g,
                replace: "[$self.renderRowButton(this?.props?.channel,'text'),$&]"
            }
        },
        {
            // Voice channels: icon before "Open Chat"
            find: "VoiceChannel.renderPopout: There must always be something to render",
            all: true,
            noWarn: true,
            replacement: {
                match: /this\.renderOpenChatButton\(\)/g,
                replace: "[$self.renderRowButton(this?.props?.channel,'voice'),$&]"
            }
        },
        {
            // Header of every chat (DM, channel, voice chat, thread)
            find: "Missing channel in Channel.renderHeaderToolbar",
            noWarn: true,
            replacement: {
                match: /this\.renderHeaderToolbar\(\)/,
                replace: "$self.wrapToolbar($&,this?.props?.channel)"
            }
        }
    ],

    renderRowButton(channel: ChannelLike, kind?: "text" | "voice") {
        // Voice channels only via their own patch so the icon doesn't appear twice
        if (kind === "text" && isVoice(channel)) return null;
        return <ErrorBoundary noop key="vc-chatpopout-row"><RowButton channel={channel} /></ErrorBoundary>;
    },

    wrapToolbar(toolbar: any, channel: ChannelLike) {
        const button = <ErrorBoundary noop key="vc-chatpopout-toolbar"><ToolbarButton channel={channel} /></ErrorBoundary>;
        return Array.isArray(toolbar) ? [button, ...toolbar] : [button, toolbar];
    },

    contextMenus: {
        "user-context": userContext,
        "channel-context": channelContext,
        "thread-context": channelContext,
        "gdm-context": channelContext
    },

    chatBarButton: {
        icon: () => <Icon path={POPOUT_PATH} size={20} />,
        render: PopoutChatButton
    },

    flux: {
        MESSAGE_CREATE(e: any) {
            if (!e.message) return;
            emitChannelEvent(e.channelId ?? e.message.channel_id, { type: "create", message: e.message, optimistic: !!e.optimistic });
        },
        MESSAGE_UPDATE(e: any) {
            if (e.message?.channel_id) emitChannelEvent(e.message.channel_id, { type: "update", message: e.message });
        },
        MESSAGE_DELETE(e: any) {
            emitChannelEvent(e.channelId, { type: "delete", ids: [e.id] });
        },
        MESSAGE_DELETE_BULK(e: any) {
            emitChannelEvent(e.channelId, { type: "delete", ids: e.ids ?? [] });
        },
        MESSAGE_SEND_FAILED(e: any) {
            emitChannelEvent(e.channelId, { type: "failed", id: e.messageId });
        },
        MESSAGE_REACTION_ADD(e: any) {
            emitChannelEvent(e.channelId, { type: "reaction", messageId: e.messageId, userId: e.userId, emoji: e.emoji, delta: 1 });
        },
        MESSAGE_REACTION_REMOVE(e: any) {
            emitChannelEvent(e.channelId, { type: "reaction", messageId: e.messageId, userId: e.userId, emoji: e.emoji, delta: -1 });
        },
        MESSAGE_REACTION_REMOVE_ALL(e: any) {
            emitChannelEvent(e.channelId, { type: "reactionClear", messageId: e.messageId });
        },
        MESSAGE_REACTION_REMOVE_EMOJI(e: any) {
            emitChannelEvent(e.channelId, { type: "reactionClear", messageId: e.messageId, emoji: e.emoji });
        }
    },

    start() {
        document.addEventListener("keydown", onKeyDown, true);
    },

    stop() {
        document.removeEventListener("keydown", onKeyDown, true);
        closeAll();
    }
});
