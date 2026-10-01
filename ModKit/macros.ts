/*
 * ModKit – Mod macros: steps, presets, permission and role checks, and execution
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { ChannelStore, GuildMemberStore, GuildRoleStore, GuildStore, PermissionsBits, PermissionStore, showToast, Toasts, UserStore } from "@webpack/common";

import { settings } from "./index";
import { canWriteNotes, describeError, formatDuration, NOTE_LABELS, NoteType, rest, sleep, writeNote } from "./notes";

const logger = new Logger("ModKit");

// ---------------------------------------------------------------- Types

export const STEP_TYPES = ["delete", "timeout", "kick", "ban", "reply", "note"] as const;
export type StepType = typeof STEP_TYPES[number];

export interface Step {
    id: string;
    type: StepType;
    /** timeout: duration in seconds */
    duration?: number;
    /** ban: delete message history (seconds) */
    deleteSeconds?: number;
    /** reply: text with {user} and {rule} */
    text?: string;
    /** reply: rule text for {rule} */
    rule?: string;
    /** note: type of note */
    noteType?: NoteType;
    /** note: custom reason (empty = macro reason) */
    reason?: string;
}

export interface Macro {
    id: string;
    name: string;
    emoji: string;
    confirm: boolean;
    /** Default reason for audit log and notes */
    reason: string;
    steps: Step[];
}

export const STEP_LABELS: Record<StepType, string> = {
    delete: "Delete message",
    timeout: "Timeout",
    kick: "Kick",
    ban: "Ban",
    reply: "Send reply",
    note: "Write ModNote"
};

export const TIMEOUT_OPTIONS = [60, 300, 600, 3600, 21600, 86400, 604800, 2419200];
export const BAN_DELETE_OPTIONS = [0, 3600, 21600, 86400, 259200, 604800];

export const uid = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------- Presets

export const SCAM_MACRO_ID = "preset-scam";

export function makePresets(): Macro[] {
    return [
        {
            id: "preset-spam",
            name: "Spam",
            emoji: "🧹",
            confirm: false,
            reason: "Spam",
            steps: [
                { id: uid(), type: "delete" },
                { id: uid(), type: "timeout", duration: 3600 },
                { id: uid(), type: "note", noteType: "timeout", reason: "" }
            ]
        },
        {
            id: SCAM_MACRO_ID,
            name: "Scam link",
            emoji: "🎣",
            confirm: true,
            reason: "Scam/phishing link",
            steps: [
                { id: uid(), type: "delete" },
                { id: uid(), type: "ban", deleteSeconds: 86400 },
                { id: uid(), type: "note", noteType: "ban", reason: "" }
            ]
        },
        {
            id: "preset-insult",
            name: "Insult",
            emoji: "🤬",
            confirm: false,
            reason: "Insult",
            steps: [
                { id: uid(), type: "delete" },
                { id: uid(), type: "note", noteType: "warn", reason: "" },
                { id: uid(), type: "reply", text: "{user} please stay respectful. Reminder of our rule: {rule}", rule: "Be respectful - no insults." }
            ]
        },
        {
            id: "preset-warn",
            name: "Warning",
            emoji: "⚠️",
            confirm: true,
            reason: "Warning",
            steps: [
                { id: uid(), type: "note", noteType: "warn", reason: "" }
            ]
        }
    ];
}

export function getMacros(): Macro[] {
    const m = settings.store.macros;
    return Array.isArray(m) ? m : makePresets();
}

/** Macro for the scam quick action (falls back to the preset if deleted) */
export function getScamMacro(): Macro {
    return getMacros().find(m => m.id === SCAM_MACRO_ID) ?? makePresets().find(m => m.id === SCAM_MACRO_ID)!;
}

// ---------------------------------------------------------------- Description

export function describeStep(step: Step): string {
    switch (step.type) {
        case "delete": return "Delete message";
        case "timeout": return `Timeout for ${formatDuration(step.duration ?? 3600)}`;
        case "kick": return "Kick from server";
        case "ban": return step.deleteSeconds
            ? `Ban + delete messages from the last ${formatDuration(step.deleteSeconds)}`
            : "Ban (keep messages)";
        case "reply": return `Send reply: “${(step.text ?? "").slice(0, 80)}${(step.text ?? "").length > 80 ? "…" : ""}”`;
        case "note": return `Write ModNote “${NOTE_LABELS[step.noteType ?? "note"]}”`;
    }
}

// ---------------------------------------------------------------- Target & checks

export interface Target {
    guildId: string;
    channelId: string;
    userId: string;
    /** Message the macro refers to (optional) */
    messageId?: string;
    messageAuthorId?: string;
    excerpt?: string;
}

export function targetFromMessage(msg: any, channel: any): Target {
    const text: string = msg.content ?? "";
    const excerpt = text.trim()
        ? text.replace(/\s+/g, " ").slice(0, 150)
        : msg.attachments?.length ? "[Attachment]" : msg.embeds?.length ? "[Embed]" : undefined;
    return {
        guildId: channel.guild_id,
        channelId: channel.id,
        userId: msg.author.id,
        messageId: msg.id,
        messageAuthorId: msg.author.id,
        excerpt
    };
}

export function messageLink(t: Target) {
    return t.messageId ? `https://discord.com/channels/${t.guildId}/${t.channelId}/${t.messageId}` : undefined;
}

function highestPosition(guildId: string, userId: string): number | null {
    const member = GuildMemberStore.getMember(guildId, userId);
    if (!member) return null;
    let max = 0;
    for (const roleId of member.roles ?? []) {
        const pos = GuildRoleStore.getRole(guildId, roleId)?.position;
        if (typeof pos === "number" && pos > max) max = pos;
    }
    return max;
}

/** Role hierarchy: null = ok, otherwise an explanation */
export function hierarchyProblem(guildId: string, targetId: string): string | null {
    const guild = GuildStore.getGuild(guildId);
    const me = UserStore.getCurrentUser()?.id;
    if (!guild || !me) return null;
    if (targetId === me) return "You cannot act against yourself.";
    if (targetId === guild.ownerId) return "The server owner cannot be moderated.";
    if (me === guild.ownerId) return null;

    const targetPos = highestPosition(guildId, targetId);
    if (targetPos == null) return null; // not a (loaded) member - Discord checks it itself
    const myPos = highestPosition(guildId, me) ?? 0;
    if (targetPos >= myPos) return "This person has a role equal to or higher than yours.";
    return null;
}

/** Checks whether a step can be run. null = ok, otherwise an explanation */
export function stepProblem(step: Step, t: Target): string | null {
    const channel = ChannelStore.getChannel(t.channelId);
    const guild = GuildStore.getGuild(t.guildId);
    if (!guild) return "Server not found.";
    const me = UserStore.getCurrentUser()?.id;
    const can = (perm: bigint, where: any = guild) => PermissionStore.can(perm, where);

    switch (step.type) {
        case "delete":
            if (!t.messageId) return "No message selected.";
            if (t.messageAuthorId === me) return null;
            return channel && can(PermissionsBits.MANAGE_MESSAGES, channel) ? null : "You are missing \"Manage Messages\" in this channel.";
        case "timeout":
            if (!can(PermissionsBits.MODERATE_MEMBERS)) return "You are missing \"Timeout Members\".";
            if (!GuildMemberStore.getMember(t.guildId, t.userId)) return "This person is not (or no longer) on the server.";
            return hierarchyProblem(t.guildId, t.userId);
        case "kick":
            if (!can(PermissionsBits.KICK_MEMBERS)) return "You are missing \"Kick Members\".";
            if (!GuildMemberStore.getMember(t.guildId, t.userId)) return "This person is not (or no longer) on the server.";
            return hierarchyProblem(t.guildId, t.userId);
        case "ban":
            if (!can(PermissionsBits.BAN_MEMBERS)) return "You are missing \"Ban Members\".";
            return hierarchyProblem(t.guildId, t.userId);
        case "reply":
            if (!channel) return "Channel not found.";
            return can(PermissionsBits.SEND_MESSAGES, channel) ? null : "You cannot send messages in this channel.";
        case "note":
            return canWriteNotes(t.guildId);
    }
}

/** Does the user have any mod permission in this channel at all? */
export function hasAnyModPermission(channel: any) {
    if (!channel?.guild_id) return false;
    const guild = { id: channel.guild_id };
    return PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel)
        || PermissionStore.can(PermissionsBits.MODERATE_MEMBERS, guild)
        || PermissionStore.can(PermissionsBits.KICK_MEMBERS, guild)
        || PermissionStore.can(PermissionsBits.BAN_MEMBERS, guild);
}

// ---------------------------------------------------------------- Execution

function auditHeaders(reason: string) {
    const r = reason.slice(0, 480);
    // Discord's HTTP client knows "reason" (sets X-Audit-Log-Reason) - to be safe, also set the header ourselves
    return { reason: r, headers: { "X-Audit-Log-Reason": encodeURIComponent(r) } };
}

function fillTemplate(text: string, step: Step, t: Target) {
    return text
        .replace(/\{user\}/g, `<@${t.userId}>`)
        .replace(/\{rule\}/g, step.rule ?? "");
}

async function runStep(step: Step, macro: Macro, t: Target, reason: string) {
    const audit = auditHeaders(`[ModKit] ${macro.name}: ${reason}`);

    switch (step.type) {
        case "delete":
            await rest("del", { url: `/channels/${t.channelId}/messages/${t.messageId}`, ...audit });
            return;
        case "timeout": {
            const until = new Date(Date.now() + (step.duration ?? 3600) * 1000).toISOString();
            await rest("patch", { url: `/guilds/${t.guildId}/members/${t.userId}`, body: { communication_disabled_until: until }, ...audit });
            return;
        }
        case "kick":
            await rest("del", { url: `/guilds/${t.guildId}/members/${t.userId}`, ...audit });
            return;
        case "ban":
            await rest("put", { url: `/guilds/${t.guildId}/bans/${t.userId}`, body: { delete_message_seconds: step.deleteSeconds ?? 0 }, ...audit });
            return;
        case "reply": {
            const content = fillTemplate(step.text ?? "", step, t).slice(0, 2000);
            if (!content.trim()) throw { message: "Reply text is empty" };
            await rest("post", {
                url: `/channels/${t.channelId}/messages`,
                body: {
                    content,
                    allowed_mentions: { parse: [], users: [t.userId] },
                    ...(t.messageId && {
                        message_reference: { message_id: t.messageId, channel_id: t.channelId, guild_id: t.guildId, fail_if_not_exists: false }
                    })
                }
            });
            return;
        }
        case "note": {
            const timeoutStep = macro.steps.find(s => s.type === "timeout");
            const noteType = step.noteType ?? "note";
            await writeNote(t.guildId, {
                type: noteType,
                userId: t.userId,
                reason: step.reason?.trim() || reason,
                duration: noteType === "timeout" ? timeoutStep?.duration : undefined,
                ref: messageLink(t),
                excerpt: t.excerpt
            });
            return;
        }
    }
}

export type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface RunHandle {
    cancelled: boolean;
}

/**
 * Runs a macro - only call after an explicit click.
 * Steps without permission are skipped; errors do not abort the whole macro.
 */
export async function runMacro(
    macro: Macro,
    t: Target,
    reason: string,
    onStatus?: (index: number, status: StepStatus, info?: string) => void,
    handle: RunHandle = { cancelled: false }
) {
    let done = 0, failed = 0, skipped = 0;
    const errors: string[] = [];

    for (let i = 0; i < macro.steps.length; i++) {
        const step = macro.steps[i];
        if (handle.cancelled) {
            onStatus?.(i, "skipped", "Cancelled");
            skipped++;
            continue;
        }

        const problem = stepProblem(step, t);
        if (problem) {
            onStatus?.(i, "skipped", problem);
            skipped++;
            continue;
        }

        onStatus?.(i, "running");
        try {
            await runStep(step, macro, t, reason || macro.reason || macro.name);
            onStatus?.(i, "done");
            done++;
        } catch (e) {
            const msg = describeError(e);
            logger.error(`Step "${step.type}" failed`, e);
            onStatus?.(i, "failed", msg);
            errors.push(`${STEP_LABELS[step.type]}: ${msg}`);
            failed++;
        }
        // Short pause between API calls
        if (i < macro.steps.length - 1) await sleep(350);
    }

    if (failed) showToast(`ModKit: ${macro.name} – ${errors[0]}${failed > 1 ? ` (+${failed - 1} more ${failed - 1 === 1 ? "error" : "errors"})` : ""}`, Toasts.Type.FAILURE);
    else if (done) showToast(`ModKit: ${macro.name} executed (${done}/${macro.steps.length}${skipped ? `, ${skipped} skipped` : ""})`, Toasts.Type.SUCCESS);
    else showToast(`ModKit: ${macro.name} - nothing executed`, Toasts.Type.MESSAGE);

    return { done, failed, skipped };
}

/** Must we ask before running? (configured, or because steps would be skipped) */
export function needsConfirm(macro: Macro, t: Target) {
    return macro.confirm || macro.steps.some(s => stepProblem(s, t) != null);
}
