/*
 * MessageSelect – Vencord Userplugin
 * Select several messages (context menu, Shift+click, ranges) and quote, copy, forward, delete
 * or screenshot them all at once.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, Message } from "@vencord/discord-types";
import { Menu } from "@webpack/common";

import { clear, isActive, mountStyle, remove, select, selectRange, state, toggle, unmountStyle } from "./store";
import { mountBar, unmountBar } from "./ui";

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    shiftClick: {
        type: OptionType.BOOLEAN,
        description: "Shift+click a message to start selecting. While selecting, Shift+click selects a range.",
        default: true
    },
    clickToggle: {
        type: OptionType.BOOLEAN,
        description: "While selecting, a plain click on a message selects or unselects it",
        default: true
    },
    forwardMode: {
        type: OptionType.SELECT,
        description: "Default forward method",
        options: [
            { label: "Native forward (one request per message)", value: "native", default: true },
            { label: "Quoted text with a header", value: "text" }
        ]
    },
    deleteDelay: {
        type: OptionType.SLIDER,
        description: "Pause between deletes and forwards in milliseconds (protects against rate limits)",
        markers: [500, 750, 1000, 1500, 2000],
        default: 1000,
        stickToMarkers: true
    },
    shotTheme: {
        type: OptionType.STRING,
        description: "Screenshot theme",
        default: "dark",
        hidden: true
    },
    shotHideNames: {
        type: OptionType.BOOLEAN,
        description: "Screenshot: hide names",
        default: false,
        hidden: true
    },
    shotHideAvatars: {
        type: OptionType.BOOLEAN,
        description: "Screenshot: hide avatars",
        default: false,
        hidden: true
    },
    shotImages: {
        type: OptionType.BOOLEAN,
        description: "Screenshot: show images",
        default: true,
        hidden: true
    }
});

// ---------------------------------------------------------------- Clicks

/** Clicks on these keep their normal behavior (links, buttons, media, reactions, the hover toolbar, edit box …) */
const INTERACTIVE = [
    "a", "button", "input", "textarea", "select", "img", "video", "audio", "canvas", "iframe",
    "[role=button]", "[role=link]", "[role=textbox]", "[role=menuitem]", "[role=checkbox]", "[role=slider]",
    "[contenteditable=true]",
    '[class*="reaction"]', '[class*="buttonContainer"]', '[class*="username"]', '[class*="avatar"]',
    '[class*="embed"]', '[class*="attachment"]', '[class*="spoiler"]', '[class*="mediaMosaic"]', '[class*="codeContainer"]'
].join(",");

function isInteractive(target: EventTarget | null) {
    const el = target as Element | null;
    if (!el?.closest) return true;
    // Only look at elements inside the message, never at the list item / article itself or above
    const item = el.closest('li[id^="chat-messages-"]');
    const article = item?.querySelector('[role="article"]') ?? item;
    for (let node: Element | null = el; node && node !== item && node !== article; node = node.parentElement) {
        if (node.matches(INTERACTIVE)) return true;
    }
    return false;
}

const selectingIn = (channelId: string) => isActive() && state.channelId === channelId && !state.busy;

function onMessageClick(message: Message, channel: Channel, event: MouseEvent) {
    if (!message?.id || !channel?.id || event.button !== 0) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (isInteractive(event.target)) return;

    const selecting = selectingIn(channel.id);
    if (event.shiftKey) {
        if (!selecting && !settings.store.shiftClick) return;
        if (selecting) selectRange(channel.id, message.id, message);
        else select(channel.id, message.id, message);
    } else {
        if (!selecting || !settings.store.clickToggle) return;
        // The user dragged to select text – leave that alone
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        toggle(channel.id, message.id, message);
    }

    event.preventDefault();
    window.getSelection()?.removeAllRanges();
}

/** Shift+mousedown would extend the text selection – prevent that when the click will select messages */
function onMouseDown(e: MouseEvent) {
    if (!e.shiftKey || e.button !== 0 || e.ctrlKey || e.altKey || e.metaKey) return;
    const item = (e.target as Element | null)?.closest?.('li[id^="chat-messages-"]');
    if (!item || isInteractive(e.target)) return;
    if (!settings.store.shiftClick && !isActive()) return;
    e.preventDefault();
}

function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !isActive() || state.busy) return;
    // Let open modals, menus and popouts close first
    if (document.querySelector('[role="dialog"], [role="menu"]')) return;
    e.preventDefault();
    e.stopPropagation();
    clear();
}

// ---------------------------------------------------------------- Context menu

const messageCtxPatch: NavContextMenuPatchCallback = (children, { message }: { message?: Message; }) => {
    if (!message?.id || !message.channel_id) return;
    const channelId = message.channel_id;
    const selecting = isActive() && state.channelId === channelId;
    const selected = selecting && state.ids.has(message.id);

    const items = [
        <Menu.MenuItem
            key="vc-msgselect-toggle"
            id="vc-msgselect-toggle"
            label={selected ? "Unselect Message" : "Select Message"}
            action={() => toggle(channelId, message.id, message)}
        />
    ];
    if (selecting && !selected && state.anchor) {
        items.push(
            <Menu.MenuItem
                key="vc-msgselect-range"
                id="vc-msgselect-range"
                label="Select Up To Here"
                action={() => selectRange(channelId, message.id, message)}
            />
        );
    }
    if (selecting) {
        items.push(
            <Menu.MenuItem
                key="vc-msgselect-clear"
                id="vc-msgselect-clear"
                label="Clear Selection"
                action={clear}
            />
        );
    }

    const group = findGroupChildrenByChildId("copy-text", children);
    if (group) {
        const index = group.findIndex(c => c?.props?.id === "copy-text");
        group.splice(index + 1, 0, ...items);
    } else {
        children.push(<Menu.MenuGroup key="vc-msgselect-group">{items}</Menu.MenuGroup>);
    }
};

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "MessageSelect",
    description: "Select several messages (right-click or Shift+click) and quote, copy, forward, delete or screenshot them all at once",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Chat", "Utility"],
    settings,

    contextMenus: {
        "message": messageCtxPatch
    },

    onMessageClick,

    flux: {
        CHANNEL_SELECT({ channelId }: { channelId?: string | null; }) {
            if (state.channelId && channelId !== state.channelId && !state.busy) clear();
        },
        MESSAGE_DELETE({ id, channelId }: { id: string; channelId: string; }) {
            remove(channelId, [id]);
        },
        MESSAGE_DELETE_BULK({ ids, channelId }: { ids: string[]; channelId: string; }) {
            remove(channelId, ids ?? []);
        }
    },

    start() {
        mountStyle();
        mountBar();
        document.addEventListener("mousedown", onMouseDown, true);
        document.addEventListener("keydown", onKeyDown, true);
    },

    stop() {
        document.removeEventListener("mousedown", onMouseDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
        clear();
        unmountBar();
        unmountStyle();
    }
});
