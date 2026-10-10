/*
 * FakeMute – Vencord Userplugin
 * Others see you as muted/deafened even though you can still talk/hear - or you really are.
 * Both can be set individually via the icon in the title bar.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { MediaEngineStore, SelectedChannelStore, UserStore } from "@webpack/common";

import { titleBarSlot } from "../_ui";
import { renderTitleBarButton, SettingsPanel } from "./ui";

const logger = new Logger("FakeMute");

const GatewayConnectionStore = findStoreLazy("GatewayConnectionStore");
const VoiceActions = findByPropsLazy("toggleSelfMute", "toggleSelfDeaf");

let running = false;

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    fakeMute: {
        type: OptionType.BOOLEAN,
        description: "Others see you as muted, but can still hear you",
        default: false,
        hidden: true,
        onChange: () => scheduleResend()
    },
    fakeDeafen: {
        type: OptionType.BOOLEAN,
        description: "Others see you as deafened, but you can still hear them",
        default: false,
        hidden: true,
        onChange: () => scheduleResend()
    },
    showTitleBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show icon in the title bar",
        default: true,
        hidden: true
    }
});

// ---------------------------------------------------------------- Modes

/** off = normal, fake = only for others, real = actual (Discord's own mute/deafen) */
export type Mode = "off" | "fake" | "real";

export function setMicMode(mode: Mode) {
    settings.store.fakeMute = mode === "fake";
    if (MediaEngineStore.isSelfMute() !== (mode === "real")) VoiceActions.toggleSelfMute();
}

export function setDeafMode(mode: Mode) {
    settings.store.fakeDeafen = mode === "fake";
    if (MediaEngineStore.isSelfDeaf() !== (mode === "real")) VoiceActions.toggleSelfDeaf();
}

// ---------------------------------------------------------------- Voice state sent to the server

interface VoiceStateArgs {
    guildId: string | null;
    channelId: string | null;
    selfMute: boolean;
    selfDeaf: boolean;
    selfVideo: boolean;
    [key: string]: any;
}

/** Last (real) voice state sent by Discord - resent when toggling */
let lastArgs: VoiceStateArgs | null = null;

function modifyVoiceState(args: VoiceStateArgs) {
    if (!args) return args;
    lastArgs = { ...args };

    if (!running || args.channelId == null) return args;
    const { fakeMute, fakeDeafen } = settings.store;
    if (!fakeMute && !fakeDeafen) return args;

    return {
        ...args,
        // On Discord, deafened always implies muted
        selfMute: args.selfMute || fakeMute || fakeDeafen,
        selfDeaf: args.selfDeaf || fakeDeafen
    };
}

let resendQueued = false;
function scheduleResend() {
    if (resendQueued) return;
    resendQueued = true;
    queueMicrotask(() => {
        resendQueued = false;
        resendVoiceState();
    });
}

/*
 * With Fake Deafen the server permanently has us stored as "deafened". When someone joins the channel, it can
 * stop forwarding the already connected participants to us (we no longer hear them) until the state is
 * sent again. So we resend it shortly after a join. (after Infinicord)
 */
let healTimer: ReturnType<typeof setTimeout> | undefined;

function onVoiceStateUpdates({ voiceStates }: { voiceStates: { userId: string; channelId?: string | null; oldChannelId?: string | null; }[]; }) {
    if (!running || !settings.store.fakeDeafen) return;
    const channelId = SelectedChannelStore.getVoiceChannelId();
    const myId = UserStore.getCurrentUser()?.id;
    if (!channelId || !voiceStates?.some(vs => vs.userId !== myId && vs.channelId === channelId && vs.oldChannelId !== channelId)) return;

    clearTimeout(healTimer);
    healTimer = setTimeout(resendVoiceState, 500);
}

function resendVoiceState() {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!lastArgs || channelId == null || lastArgs.channelId !== channelId) return;

    try {
        const socket = GatewayConnectionStore.getSocket();
        if (!socket?.isSessionEstablished()) return;
        socket.voiceStateUpdate(lastArgs);
    } catch (e) {
        logger.error("Failed to send voice state", e);
    }
}

// ---------------------------------------------------------------- Plugin

const plugin = definePlugin({
    name: "FakeMute",
    description: "Fake Mute & Fake Deafen: others see you as muted/deafened even though you can still talk/hear - or really mute/deafen yourself, configurable from the title bar",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Voice", "Utility"],
    settings,

    patches: [
        {
            // Title bar on the left (next to Back/Forward & Inbox): append the button at the end.
            // Order of plugin icons = plugin load order (alphabetical by folder).
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,2500}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        },
        {
            // GatewaySocket.voiceStateUpdate: modify the state right before it is sent to Discord
            find: "voiceServerPing(){",
            replacement: {
                match: /voiceStateUpdate\((\i)\)\{/,
                replace: "$&$1=$self.modifyVoiceState($1);"
            }
        }
    ],

    renderTitleBarButton: titleBarSlot("FakeMute", renderTitleBarButton),
    modifyVoiceState,

    flux: {
        VOICE_STATE_UPDATES: onVoiceStateUpdates
    },

    toolboxActions: {
        "Toggle Fake Mute": () => { settings.store.fakeMute = !settings.store.fakeMute; },
        "Toggle Fake Deafen": () => { settings.store.fakeDeafen = !settings.store.fakeDeafen; }
    },

    start() {
        running = true;
        scheduleResend();
    },

    stop() {
        running = false;
        clearTimeout(healTimer);
        // Restore the real state
        resendVoiceState();
    }
});

export default plugin;
