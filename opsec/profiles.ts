/*
 * OpSec – Profiles (Standard / Paranoid / Manual)
 * Must not import anything from @webpack / @api (pure data).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type Profile = "standard" | "paranoid" | "custom";

export interface Config {
    // Stealth
    silentTyping: boolean;
    hideActivity: boolean;
    invisibleStatus: boolean;

    // Links
    cleanSentLinks: boolean;
    cleanClickedLinks: boolean;
    dangerousLinkWarning: boolean;
    confirmExternalLinks: boolean;
    /** Online blocklist of known scam/phishing domains */
    scamBlocklist: boolean;

    // Files
    stripMetadata: boolean;
    anonymizeFilenames: boolean;
    /** Image editor (redact, crop …) before upload */
    uploadEditor: boolean;

    // Screen
    contentProtection: boolean;
    curtainOnBlur: boolean;
    panicHotkey: boolean;

    // Streaming
    /** Streaming protection: blur DMs, hide servers/channels, mute notifications while you stream */
    screenshareGuard: boolean;
}

export type ConfigKey = keyof Config;

const STANDARD: Config = {
    silentTyping: false,
    hideActivity: true,
    invisibleStatus: false,

    cleanSentLinks: true,
    cleanClickedLinks: true,
    dangerousLinkWarning: true,
    confirmExternalLinks: false,
    // Only downloads a public list, sends nothing – so it is on in Standard too
    scamBlocklist: true,

    stripMetadata: true,
    anonymizeFilenames: true,
    uploadEditor: false,

    contentProtection: false,
    curtainOnBlur: false,
    panicHotkey: true,

    // Only applies while you stream – otherwise harmless
    screenshareGuard: true
};

const PARANOID: Config = {
    ...STANDARD,
    silentTyping: true,
    invisibleStatus: true,
    confirmExternalLinks: true,
    contentProtection: true,
    curtainOnBlur: true,
    uploadEditor: true
};

export const PRESETS: Record<Exclude<Profile, "custom">, Config> = { standard: STANDARD, paranoid: PARANOID };

export const CONFIG_KEYS = Object.keys(STANDARD) as ConfigKey[];

/** Compute the effective configuration from the stored plugin settings. */
export function resolveConfig(stored: Partial<Record<string, any>> | undefined): Config {
    const profile = (stored?.profile ?? "standard") as Profile;
    if (profile !== "custom") return { ...(PRESETS[profile] ?? STANDARD) };

    const config = { ...STANDARD };
    for (const key of CONFIG_KEYS) {
        const v = stored?.[key];
        if (v !== undefined && v !== null) config[key] = v;
    }
    return config;
}
