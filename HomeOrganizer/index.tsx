/*
 * HomeOrganizer – Vencord userplugin
 * Tidies up your Home view: sort & close DMs by activity, review friend requests with a spam score.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Menu, RelationshipStore } from "@webpack/common";

import { isProtectedId, toggleProtected } from "./data";
import { startDividerFix, stopDividerFix } from "./divider";
import { cancelAll } from "./queue";
import { openOrganizer, renderTitleBarButton, SettingsPanel } from "./ui";

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    activeDays: {
        type: OptionType.NUMBER,
        description: "DMs count as active up to this many days since the last message",
        default: 7,
        hidden: true
    },
    quietDays: {
        type: OptionType.NUMBER,
        description: "DMs count as quiet up to this many days, after that as dormant",
        default: 30,
        hidden: true
    },
    spamAccountDays: {
        type: OptionType.NUMBER,
        description: "Accounts younger than this many days count as new (spam signal)",
        default: 30,
        hidden: true
    },
    protectPinned: {
        type: OptionType.BOOLEAN,
        description: "Never close DMs in PinDMs categories",
        default: true,
        hidden: true
    },
    protectedIds: {
        type: OptionType.CUSTOM,
        default: [] as string[]
    },
    dividerFix: {
        type: OptionType.BOOLEAN,
        description: "Render PinDMs categories made of dashes as a divider line",
        default: true,
        hidden: true,
        onChange: (v: boolean) => v && running ? startDividerFix() : stopDividerFix()
    },
    showTitleBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show icon in the title bar",
        default: true,
        hidden: true
    }
});

let running = false;

// ---------------------------------------------------------------- Context menus

/** Right-click on a DM / group in the DM list or on a user */
const privateChannelPatch: NavContextMenuPatchCallback = (children, { channel, user }: { channel?: any; user?: any; }) => {
    const isPrivate = channel && (channel.type === 1 || channel.type === 3);
    const pendingType = user?.id ? RelationshipStore.getRelationshipType(user.id) : 0;
    const isRequest = pendingType === 3 || pendingType === 4;
    if (!isPrivate && !isRequest) return;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem id="vc-homeorganizer" label="HomeOrganizer">
                {isPrivate && (
                    <Menu.MenuCheckboxItem
                        id="vc-homeorganizer-protect"
                        label="Never close"
                        checked={isProtectedId(channel.id)}
                        action={() => toggleProtected(channel.id)}
                    />
                )}
                <Menu.MenuItem
                    id="vc-homeorganizer-open"
                    label={isRequest ? "Review requests" : "Clean up DMs"}
                    action={() => openOrganizer(isRequest ? "requests" : "dms")}
                />
            </Menu.MenuItem>
        </Menu.MenuGroup>
    );
};

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "HomeOrganizer",
    description: "Tidy up Home: group DMs by activity & bulk-close them, review and answer friend requests with a spam score, PinDMs dividers",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Friends", "Organisation", "Utility"],
    settings,

    patches: [
        {
            // Title bar, left side (next to back/forward & inbox): append button at the end - same pattern as FakeMute/Radar
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,600}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        }
    ],

    renderTitleBarButton,

    contextMenus: {
        "user-context": privateChannelPatch,
        "gdm-context": privateChannelPatch
    },

    toolboxActions: {
        "Clean up DMs": () => openOrganizer("dms"),
        "Review friend requests": () => openOrganizer("requests")
    },

    start() {
        running = true;
        if (settings.store.dividerFix) startDividerFix();
    },

    stop() {
        running = false;
        stopDividerFix();
        // Immediately cancel running bulk actions & profile lookups
        cancelAll();
    }
});
