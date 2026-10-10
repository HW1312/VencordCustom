/*
 * StreamUnlock – Vencord Userplugin (experimental)
 * Adds 75 up to 360 FPS to the screen share quality picker, can switch the encoder to H264 and raise the bitrate
 * limit. Tested live (RTX 3070): 500 FPS broke the stream for viewers; above the monitor's refresh rate the capture
 * can't keep up. With H265 the video encoder was full at 90 FPS (99 %), with H264 at 23 % – so H264 is the default. The resolution never goes above the monitor's own ("Source"), so no 4K+ options.
 * Has its own stream debugger (debug.tsx), since Discord's "Stream Info" stays empty with these frame rates.
 * Needs FakeNitro's stream quality bypass (or Nitro).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

import { Button, Note } from "../_ui";
import { openSystemSettings, startDebug, stopDebug } from "./debug";

const EXTRA_FPS = [75, 90, 120, 144, 240, 360];
const RESOLUTIONS = [0, 1440, 1080, 720, 480];

function ViewerHint() {
    return (
        <Note tone="warn">
            <b>Viewers see nothing / the stream keeps loading at high FPS?</b> Their graphics card can't decode it
            (often AMD at 1080p and 240 FPS – their debugger then shows "Decoded FPS 0"). Fix on the <b>viewer's</b> PC:
            Settings → System → turn off <b>Enable Hardware Acceleration</b> (Discord restarts). Or stream with fewer FPS.
            <div style={{ marginTop: 8 }}>
                <Button small variant="tinted" color="orange" onClick={openSystemSettings}>Open System settings</Button>
            </div>
        </Note>
    );
}

const settings = definePluginSettings({
    viewerHint: {
        type: OptionType.COMPONENT,
        component: ViewerHint
    },
    maxBitrate: {
        type: OptionType.NUMBER,
        description: "Max stream bitrate in Mbit/s – 0 = Discord decides. Stream blurry or blocky when things move? Raise it: "
            + "1080p ≈ 8–12, 1440p or 75 / 90 FPS ≈ 15–25. Viewers stutter or your stream lags? Lower it – your upload and "
            + "their download have to handle it (check your upload speed in a speed test and stay below it).",
        default: 0
    },
    codec: {
        type: OptionType.SELECT,
        description: "Video codec for your stream. H265 looks better per Mbit/s but works your GPU's video encoder harder; "
            + "H264 is lighter on the encoder (needs a bit more bitrate for the same quality). Restart the stream after changing it.",
        options: [
            { label: "H264 – much less load on the video encoder (recommended for 75+ FPS)", value: "h264", default: true },
            { label: "Automatic (Discord picks, usually H265)", value: "auto" }
        ]
    },
    debug: {
        type: OptionType.BOOLEAN,
        description: "Stream debugger: a small panel with the real FPS (captured / encoded / received), resolution, codec and bitrate while you stream or watch – handy to check the settings above",
        default: false,
        onChange: on => on ? startDebug() : stopDebug()
    }
});

export default definePlugin({
    name: "StreamUnlock",
    description: "Screen share with 75 to 360 FPS, a lighter H264 encoder and a custom bitrate, plus a stream debugger with the real FPS",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Media", "Voice"],
    settings,

    patches: [
        {
            // Stream quality constants: frame rates, the options in the picker and what's allowed
            find: "Unknown frame rate",
            replacement: [
                {
                    // Frame rate check throws for anything but 5 / 15 / 30 / 60
                    match: /(function \i\((\i)\)\{)(switch\(\2\)\{case 5:return 5;)/,
                    replace: "$1return $2;$3"
                },
                {
                    // Which resolution + frame rate combinations exist – ours first, without requirements
                    match: /(let \i=\[)(\{resolution:0,fps:60,quality:)/,
                    replace: "$1...$self.extraQualities,$2"
                },
                {
                    // Frame rate options in the picker: 75 up to 360 after 60
                    match: /(\i)\(60,\(\)=>(\i\.intl\.formatToPlainString\(\i\.t\[[^\]]+\],\{value:)60\}\)\)\]/,
                    replace: "$1(60,()=>$2 60})),$1(75,()=>$2 75})),$1(90,()=>$2 90})),$1(120,()=>$2 120})),$1(144,()=>$2 144})),$1(240,()=>$2 240})),$1(360,()=>$2 360}))]"
                }
            ]
        },
        {
            // Codecs we offer for encoding – without H265, Discord falls back to H264
            find: 'name:"H265",encode:!',
            replacement: {
                match: /(name:"H265",encode:)(!\i\.has\(\i\.\i\.H265_DISABLE_ENCODE\))/,
                replace: "$1$self.h265Encode()&&$2"
            }
        },
        {
            // The bitrate limit for the stream encoder
            find: "setDesktopEncodingOptions(e,t,n){",
            replacement: {
                match: /(let (\i)=this\.calcMaxBitrateFunc\(\{width:\i,height:\i,framerate:\i,videoCodec:this\.currentVideoCodec\}\));/,
                replace: "$1;$2=$self.maxBitrate($2);"
            }
        }
    ],

    /** Every resolution with the new frame rates – listed first, so the picker allows them */
    extraQualities: RESOLUTIONS.flatMap(resolution => EXTRA_FPS.map(fps => ({ resolution, fps }))),

    start() {
        if (settings.store.debug) startDebug();
    },

    stop() {
        stopDebug();
    },

    h265Encode() {
        return settings.store.codec !== "h264";
    },

    maxBitrate(discord: number | null | undefined) {
        const mbit = settings.store.maxBitrate;
        return mbit > 0 ? mbit * 1_000_000 : discord;
    }
});
