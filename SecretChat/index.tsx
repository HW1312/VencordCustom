/*
 * SecretChat – Vencord Userplugin
 * End-to-end encrypted messages in any chat. Turn it on per chat with the lock in the chat bar: your messages
 * are encrypted on your PC, and only people with SecretChat and the same key read them – everyone else sees
 * random characters. Keys: private (handshake with one person) or group (code or password).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { User } from "@vencord/discord-types";
import { ChannelStore, FluxDispatcher, Menu, SelectedChannelStore, showToast, Toasts, UserStore } from "@webpack/common";

import { intercept, onBeforeEdit, onBeforeSend, retryHandshakes, retryLocked, startHandshake } from "./messages";
import { settings } from "./settings";
import { loadState } from "./store";
import { ChatButton, LockDecoration, LockIcon, MessageCard } from "./ui";

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
            await loadState();
        } catch (e) {
            logger.error("Could not load the keyring", e);
        }
        retryLocked();
        retryHandshakes();
    },

    stop() {
        const list = (FluxDispatcher as any)._interceptors as unknown[] | undefined;
        const i = list?.indexOf(intercept) ?? -1;
        if (i !== -1) list!.splice(i, 1);
    }
});
