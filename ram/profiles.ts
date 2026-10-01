/*
 * RamSaver – profiles (Balanced / Maximum / Manual)
 * Used in the Discord window AND in the Electron main process - therefore must
 * not import anything from @webpack / @api.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type Profile = "balanced" | "max" | "custom";

export interface Config {
    // Clean up RAM
    autoTrim: boolean;
    trimInterval: number;
    trimWhenHidden: boolean;
    trimMessageCache: boolean;
    trimWorkingSet: boolean;
    clearHttpCache: boolean;

    // Discord settings (restored when turned off)
    reducedMotion: boolean;
    disableAnimatedMedia: boolean;
    disableEmbeds: boolean;

    // Visuals (CSS)
    disableAnimations: boolean;
    disableBlur: boolean;
    hideProfileEffects: boolean;

    // Restart required
    codeTweaks: boolean;
    backgroundThrottling: boolean;
    aggressiveBackground: boolean;
    noSpareRenderer: boolean;
    v8OptimizeForSize: boolean;
    lowEndDevice: boolean;
}

export type ConfigKey = keyof Config;
/** Only the on/off options */
export type BoolKey = { [K in ConfigKey]: Config[K] extends boolean ? K : never }[ConfigKey];

const BALANCED: Config = {
    autoTrim: true,
    trimInterval: 15,
    trimWhenHidden: true,
    trimMessageCache: true,
    trimWorkingSet: false,
    clearHttpCache: false,

    reducedMotion: true,
    disableAnimatedMedia: false,
    disableEmbeds: false,

    disableAnimations: true,
    disableBlur: true,
    hideProfileEffects: true,

    codeTweaks: true,
    backgroundThrottling: true,
    aggressiveBackground: false,
    noSpareRenderer: true,
    v8OptimizeForSize: false,
    lowEndDevice: false
};

const MAX: Config = {
    ...BALANCED,
    trimInterval: 5,
    trimWorkingSet: true,
    disableAnimatedMedia: true,
    disableEmbeds: true,
    aggressiveBackground: true,
    v8OptimizeForSize: true
    // lowEndDevice is deliberately left off: it can degrade gradients/image quality on some GPUs
};

export const PRESETS: Record<Exclude<Profile, "custom">, Config> = { balanced: BALANCED, max: MAX };

export const CONFIG_KEYS = Object.keys(BALANCED) as ConfigKey[];

/** Settings that only take effect after a Discord restart */
export const RESTART_KEYS = ["codeTweaks", "backgroundThrottling", "aggressiveBackground", "noSpareRenderer", "v8OptimizeForSize", "lowEndDevice"] as const satisfies readonly ConfigKey[];
export type StartupState = Pick<Config, typeof RESTART_KEYS[number]>;

/** Compute the effective configuration from the saved plugin settings. */
export function resolveConfig(stored: Partial<Record<string, any>> | undefined): Config {
    const profile = (stored?.profile ?? "balanced") as Profile;
    if (profile !== "custom") return { ...(PRESETS[profile] ?? BALANCED) };

    const config = { ...BALANCED };
    for (const key of CONFIG_KEYS) {
        const v = stored?.[key];
        if (v !== undefined && v !== null) (config as any)[key] = v;
    }
    return config;
}
