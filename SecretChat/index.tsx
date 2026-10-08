/*
 * SecretChat – Vencord Userplugin
 * End-to-end encrypted messages in any chat. Turn it on per chat with the lock in the chat bar: your messages
 * are encrypted on your PC, and only people with SecretChat and the same key read them – everyone else sees
 * random characters. Keys: private (handshake with one person) or group (code or password).
 * Secret rooms: chats that are always encrypted, listed under the lock in the server list, with their own pings.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { addServerListElement, removeServerListElement, ServerListRenderPosition } from "@api/ServerList";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { User } from "@vencord/discord-types";
import { ChannelStore, FluxDispatcher, Menu, SelectedChannelStore, showToast, Toasts, UserStore } from "@webpack/common";

import { loadedMessageHooks } from "../ChatPopout/messages";
import { renderTitleBarButton, ServerListIcon } from "./area";
import { decryptLoaded, intercept, onBeforeEdit, onBeforeSend, retryHandshakes, retryLocked, startHandshake, unwrapMessageActions, wrapMessageActions } from "./messages";
import { isRoomMessage, retryRooms } from "./rooms";
import { settings } from "./settings";
import { loadState } from "./store";
import { ChatButton, LockDecoration, LockIcon, MessageCard } from "./ui";
import { closeRoomsWindow } from "./window";

const logger = new Logger("SecretChat");

const userContext: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user || user.bot || user.id === UserStore.getCurrentUser()?.id) return;

    children.push(
        <Menu.MenuItem
            id="vc-secretchat-connect"
            label="Start encrypted chat"
            icon={LockIcon}
            action={() => {
                // Prefer the DM with them – otherwise the request goes into the chat that is open
                const channelId = ChannelStore.getDMFromUserId(user.id) ?? SelectedChannelStore.getChannelId();
                if (!channelId) return showToast("Open a chat with them first", Toasts.Type.FAILURE);
                startHandshake(user, channelId);
            }}
        />
    );
};

export default definePlugin({
    name: "SecretChat",
    description: "End-to-end encrypted messages: only people with SecretChat and your key can read them, everyone else sees random characters",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Chat", "Privacy", "Utility"],
    settings,
    // ChatPopout draws the chat in the rooms window
    dependencies: ["ServerListAPI", "ChatPopout"],

    patches: [
        {
            // Left side of the title bar (next to Back / Forward) – same spot as FriendDock, each appends its button
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,2500}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        },
        {
            // Discord's "should this message notify" check – rooms ping through SecretChat instead (decrypted text)
            find: ".SUPPRESS_NOTIFICATIONS))return!1",
            replacement: {
                match: /if\(null!=(\i)\.flags&&\(0,\i\.\i\)\(\i\.flags,\i\.\i\.SUPPRESS_NOTIFICATIONS\)\)return!1;/,
                replace: "if($self.isRoomMessage($1))return!1;$&"
            }
        }
    ],

    isRoomMessage,
    renderTitleBarButton,

    contextMenus: {
        "user-context": userContext
    },

    onBeforeMessageSend: onBeforeSend,
    onBeforeMessageEdit: onBeforeEdit,

    renderMessageDecoration: props => <LockDecoration message={props.message} />,
    renderMessageAccessory: props => <MessageCard message={props.message} />,

    chatBarButton: {
        icon: LockIcon,
        render: ChatButton
    },

    async start() {
        FluxDispatcher.addInterceptor(intercept);
        try {
            wrapMessageActions();
        } catch (e) {
            logger.error("Could not wrap sendMessage – the rooms window won't send", e);
        }
        loadedMessageHooks.add(decryptLoaded);
        addServerListElement(ServerListRenderPosition.Above, ServerListIcon);
        try {
            await loadState();
        } catch (e) {
            logger.error("Could not load the keyring", e);
        }
        retryLocked();
        retryHandshakes();
        retryRooms();
    },

    stop() {
        closeRoomsWindow();
        unwrapMessageActions();
        loadedMessageHooks.delete(decryptLoaded);
        removeServerListElement(ServerListRenderPosition.Above, ServerListIcon);
        const list = (FluxDispatcher as any)._interceptors as unknown[] | undefined;
        const i = list?.indexOf(intercept) ?? -1;
        if (i !== -1) list!.splice(i, 1);
    }
});
