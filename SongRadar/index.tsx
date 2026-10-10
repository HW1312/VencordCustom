/*
 * SongRadar – Vencord Userplugin
 * Recognizes music like Shazam: listens to what your PC plays (voice channels, streams, YouTube, Spotify …) or a
 * video / audio in the chat and shows title, artist and cover with links to Spotify, YouTube and Apple Music.
 * Uses Shazam's own recognition (fingerprint made locally, see signature.ts) – no account or key.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import type { Message } from "@vencord/discord-types";
import { Menu } from "@webpack/common";

import { titleBarSlot } from "../_ui";
import { cancel, recognizeMedia, Song } from "./radar";
import { openRadarWindow, RadarMenuIcon, renderTitleBarButton, SettingsPanel } from "./ui";

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    /** Volume of the 30 s preview, 0..1 */
    previewVolume: {
        type: OptionType.CUSTOM,
        default: 0.4,
        hidden: true
    },
    showTitleBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show icon in the title bar",
        default: true,
        hidden: true
    },
    /** Recognized songs, newest first */
    history: {
        type: OptionType.CUSTOM,
        default: [] as Song[],
        hidden: true
    }
});

// ---------------------------------------------------------------- Right-click on a video / audio

const isMedia = (a: any) => /^(audio|video)\//.test(a?.content_type ?? "") || /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|mp4|webm|mov|mkv)$/i.test(a?.filename ?? "");

const messageContext: NavContextMenuPatchCallback = (children, { message }: { message?: Message; }) => {
    const media = (message?.attachments ?? []).filter(isMedia);
    if (!media.length) return;

    const item = (a: any, label: string) => (
        <Menu.MenuItem
            id={`vc-songradar-${a.id}`}
            label={label}
            icon={RadarMenuIcon}
            action={() => {
                openRadarWindow();
                recognizeMedia(a.url, a.filename);
            }}
        />
    );

    children.push(
        <Menu.MenuGroup>
            {media.length === 1
                ? item(media[0], "Recognize song")
                : (
                    <Menu.MenuItem id="vc-songradar-media" label="Recognize song">
                        {media.map(a => item(a, a.filename))}
                    </Menu.MenuItem>
                )}
        </Menu.MenuGroup>
    );
};

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "SongRadar",
    description: "Recognize music like Shazam – what your PC plays (voice, streams, videos …) or a video / audio in the chat",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Media", "Voice", "Utility"],
    settings,

    patches: [
        {
            // Left side of the title bar, like the other VoidCord plugins
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,2500}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        }
    ],

    renderTitleBarButton: titleBarSlot("SongRadar", renderTitleBarButton),

    contextMenus: {
        "message": messageContext
    },

    stop() {
        cancel();
    }
});
