/*
 * OpSec – Security check: audits account and privacy settings and fixes them with one click.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { Logger } from "@utils/Logger";
import { ConnectedAccountsStore, RestAPI, SettingsRouter, UserSettingsActionCreators, UserSettingsProtoStore, UserStore } from "@webpack/common";

const logger = new Logger("OpSec");

const ShowCurrentGame = getUserSettingLazy<boolean>("status", "showCurrentGame")!;

export type CheckStatus = "ok" | "warn" | "unknown";
export type Severity = "high" | "medium" | "low";

export interface Check {
    id: string;
    title: string;
    /** Why this matters */
    hint: string;
    severity: Severity;
    status(): CheckStatus;
    /** Fix automatically (if possible) */
    fix?(): Promise<void> | void;
    /** Label of the fix button */
    fixLabel?: string;
}

// ---------------------------------------------------------------- Discord settings (protobuf)

/** Some fields are "wrapped" in Discord's protobuf ({ value: x }) */
const unwrap = (v: any) => v != null && typeof v === "object" && "value" in v ? v.value : v;

function privacy(): Record<string, any> {
    return (UserSettingsProtoStore as any)?.settings?.privacy ?? {};
}

function readPrivacy(field: string) {
    return unwrap(privacy()[field]);
}

async function writePrivacy(values: Record<string, any>, wrapped: string[]) {
    const creators = UserSettingsActionCreators.PreloadedUserSettingsActionCreators;
    await creators.updateAsync("privacy", (draft: Record<string, any>) => {
        for (const [field, value] of Object.entries(values)) {
            const current = draft[field];
            const isWrapped = current != null ? typeof current === "object" : wrapped.includes(field);
            draft[field] = isWrapped ? { value } : value;
        }
    }, 0);
}

function privacyCheck(opts: {
    id: string; title: string; hint: string; severity: Severity;
    field: string; wanted: any; wrapped: boolean; fixLabel?: string;
}): Check {
    return {
        id: opts.id,
        title: opts.title,
        hint: opts.hint,
        severity: opts.severity,
        fixLabel: opts.fixLabel,
        status() {
            const v = readPrivacy(opts.field);
            if (v === undefined && !(UserSettingsProtoStore as any)?.settings?.privacy) return "unknown";
            return (v ?? false) === opts.wanted ? "ok" : "warn";
        },
        fix: () => writePrivacy({ [opts.field]: opts.wanted }, opts.wrapped ? [opts.field] : [])
    };
}

// ---------------------------------------------------------------- Consents (data usage)

interface Consents {
    usage_statistics?: { consented: boolean; };
    personalization?: { consented: boolean; };
}

let consents: Consents | null = null;
let consentsLoading: Promise<void> | null = null;
const consentListeners = new Set<() => void>();

export function onConsentsChange(fn: () => void) {
    consentListeners.add(fn);
    return () => void consentListeners.delete(fn);
}

export function loadConsents(force = false) {
    if (consentsLoading && !force) return consentsLoading;
    consentsLoading = RestAPI.get({ url: "/users/@me/consent" })
        .then(res => { consents = res.body; })
        .catch(e => { logger.error("Failed to load consents", e); })
        .finally(() => consentListeners.forEach(l => l()));
    return consentsLoading;
}

async function revokeConsent(type: keyof Consents) {
    await RestAPI.post({ url: "/users/@me/consent", body: { grant: [], revoke: [type] } });
    await loadConsents(true);
}

function consentCheck(type: keyof Consents, title: string, hint: string): Check {
    return {
        id: "consent-" + type,
        title,
        hint,
        severity: "medium",
        fixLabel: "Revoke",
        status: () => {
            const c = consents?.[type];
            if (!c) return "unknown";
            return c.consented ? "warn" : "ok";
        },
        fix: () => revokeConsent(type)
    };
}

// ---------------------------------------------------------------- Connected accounts

function visibleConnections(): any[] {
    return (ConnectedAccountsStore.getAccounts?.() ?? []).filter((a: any) => a.visibility === 1 || a.visibility === true);
}

async function hideConnections() {
    for (const acc of visibleConnections()) {
        try {
            await RestAPI.patch({
                url: `/users/@me/connections/${acc.type}/${encodeURIComponent(acc.id)}`,
                body: { visibility: false }
            });
        } catch (e) {
            logger.error(`Failed to hide connection ${acc.type}`, e);
        }
    }
}

// ---------------------------------------------------------------- All checks

export const CHECKS: Check[] = [
    {
        id: "mfa",
        title: "Two-factor authentication enabled",
        hint: "The most important protection against account theft. Without 2FA a stolen password is enough.",
        severity: "high",
        status: () => UserStore.getCurrentUser()?.mfaEnabled ? "ok" : "warn",
        fixLabel: "Set up",
        fix: () => SettingsRouter?.openUserSettings?.()
    },
    {
        id: "email",
        title: "Email address verified",
        hint: "Without a verified email you can hardly recover the account after a theft.",
        severity: "medium",
        status: () => UserStore.getCurrentUser()?.verified ? "ok" : "warn"
    },
    {
        id: "notrack",
        title: "Discord telemetry blocked",
        hint: "Vencord's NoTrack stops your click and usage behavior from being sent to Discord and Sentry.",
        severity: "medium",
        status: () => isPluginEnabled("NoTrack") && Settings.plugins.NoTrack?.disableAnalytics !== false ? "ok" : "warn",
        fixLabel: "Enable",
        fix: () => {
            Settings.plugins.NoTrack.enabled = true;
            Settings.plugins.NoTrack.disableAnalytics = true;
        }
    },
    consentCheck("usage_statistics", "Usage data not shared with Discord",
        "\"Use data to improve Discord\": Discord uses this to analyze how you use the app."),
    consentCheck("personalization", "No personalization by Discord",
        "\"Use data to customize Discord\": Discord builds a profile of your interests from it."),
    {
        id: "activity",
        title: "Activity (games, music) not shared",
        hint: "Otherwise everyone can see which game/program you are running – reveals habits and online times.",
        severity: "medium",
        fixLabel: "Hide",
        status: () => {
            const v = ShowCurrentGame?.getSetting?.();
            return v === undefined ? "unknown" : v ? "warn" : "ok";
        },
        fix: () => ShowCurrentGame.updateSetting(false)
    },
    {
        id: "connections",
        title: "Connected accounts not visible on profile",
        hint: "Steam, Spotify, Twitch, GitHub … on your profile tie your Discord account to your identity on other platforms.",
        severity: "high",
        fixLabel: "Hide all",
        status: () => visibleConnections().length ? "warn" : "ok",
        fix: hideConnections
    },
    privacyCheck({
        id: "legacy-username",
        title: "Legacy username (with #1234) hidden",
        hint: "Your old name with discriminator can link you to old accounts, leaks and screenshots.",
        severity: "medium",
        field: "hideLegacyUsername",
        wanted: true,
        wrapped: true,
        fixLabel: "Hide"
    }),
    privacyCheck({
        id: "local-time",
        title: "Local time not on profile",
        hint: "Your time on your profile reveals your time zone and thus roughly where you live.",
        severity: "medium",
        field: "showLocalTime",
        wanted: false,
        wrapped: true,
        fixLabel: "Hide"
    }),
    privacyCheck({
        id: "dms",
        title: "No DMs from strangers in shared servers",
        hint: "Most scam, phishing and malware messages arrive as DMs from strangers in shared servers. Applies to newly joined servers.",
        severity: "high",
        field: "defaultGuildsRestricted",
        wanted: true,
        wrapped: false,
        fixLabel: "Block"
    }),
    {
        id: "discovery",
        title: "Not discoverable by phone number/email",
        hint: "Otherwise anyone who knows your number or email can find you on Discord – and vice versa.",
        severity: "medium",
        fixLabel: "Turn off",
        status: () => {
            if (!(UserSettingsProtoStore as any)?.settings?.privacy) return "unknown";
            // Not set = Discord default (discoverable)
            return readPrivacy("friendDiscoveryFlags") === 0 && !readPrivacy("contactSyncEnabled") ? "ok" : "warn";
        },
        fix: () => writePrivacy({ friendDiscoveryFlags: 0, contactSyncEnabled: false }, ["friendDiscoveryFlags", "contactSyncEnabled"])
    },
    privacyCheck({
        id: "platform-accounts",
        title: "No automatic account detection",
        hint: "Otherwise Discord scans your PC for other platforms (e.g. Xbox, Battle.net) and suggests connections.",
        severity: "low",
        field: "detectPlatformAccounts",
        wanted: false,
        wrapped: true,
        fixLabel: "Turn off"
    }),
    privacyCheck({
        id: "drops",
        title: "Quest/Drops tracking declined",
        hint: "For Quests, Discord analyzes which games you play and for how long.",
        severity: "low",
        field: "dropsOptedOut",
        wanted: true,
        wrapped: true,
        fixLabel: "Decline"
    }),
    privacyCheck({
        id: "quests-3p",
        title: "No quest data to third parties",
        hint: "Prevents Discord from sharing data about your Quests with advertising partners.",
        severity: "low",
        field: "quests3PDataOptedOut",
        wanted: true,
        wrapped: true,
        fixLabel: "Decline"
    }),
    privacyCheck({
        id: "a11y",
        title: "No accessibility tool detection",
        hint: "Otherwise Discord records whether you use a screen reader or similar.",
        severity: "low",
        field: "allowAccessibilityDetection",
        wanted: false,
        wrapped: false,
        fixLabel: "Turn off"
    })
];

export function getAuditSummary() {
    let ok = 0, warn = 0, unknown = 0, highWarn = 0;
    for (const c of CHECKS) {
        let s: CheckStatus;
        try {
            s = c.status();
        } catch {
            s = "unknown";
        }
        if (s === "ok") ok++;
        else if (s === "warn") {
            warn++;
            if (c.severity === "high") highWarn++;
        } else unknown++;
    }
    return { ok, warn, unknown, highWarn, total: ok + warn };
}

export async function runFix(check: Check) {
    try {
        await check.fix?.();
    } catch (e) {
        logger.error(`Failed to fix "${check.title}"`, e);
        throw e;
    }
}
