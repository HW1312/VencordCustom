/*
 * ChatPopout – slash commands in the popout: load and run available app and Vencord commands
 * App commands are sent to Discord as interactions, just like in the normal client.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { commands as vencordCommands } from "@api/Commands";
import { sendMessage } from "@utils/discord";
import { AuthenticationStore, ChannelStore, GuildStore, RestAPI, SnowflakeUtils } from "@webpack/common";

import { logger } from "./index";

// ---------------------------------------------------------------- Types

/** Discord's option types */
export const OptionType = {
    SUB_COMMAND: 1,
    SUB_COMMAND_GROUP: 2,
    STRING: 3,
    INTEGER: 4,
    BOOLEAN: 5,
    USER: 6,
    CHANNEL: 7,
    ROLE: 8,
    MENTIONABLE: 9,
    NUMBER: 10,
    ATTACHMENT: 11
} as const;

export interface CommandOption {
    type: number;
    name: string;
    description: string;
    required?: boolean;
    choices?: { name: string; value: string | number; }[];
}

export interface PopoutCommand {
    key: string;
    /** Full name incl. subcommand, e.g. "music play" */
    name: string;
    description: string;
    source: string;
    icon: string | null;
    options: CommandOption[];
    /** Why the command can't run in the popout (e.g. needs a file upload) */
    unsupported?: string;
    run(values: Record<string, string>): Promise<void>;
}

// ---------------------------------------------------------------- Value conversion

const SNOWFLAKE_TYPES = new Set<number>([OptionType.USER, OptionType.CHANNEL, OptionType.ROLE, OptionType.MENTIONABLE]);

/** Converts an input into the value Discord expects for the option type */
function convert(opt: CommandOption, raw: string): string | number | boolean {
    const value = raw.trim();
    if (opt.choices?.length) {
        const choice = opt.choices.find(c => String(c.value) === value);
        if (choice) return choice.value;
    }
    switch (opt.type) {
        case OptionType.INTEGER: {
            const n = Number.parseInt(value, 10);
            if (!Number.isFinite(n)) throw new Error(`"${opt.name}" must be a whole number`);
            return n;
        }
        case OptionType.NUMBER: {
            const n = Number(value.replace(",", "."));
            if (!Number.isFinite(n)) throw new Error(`"${opt.name}" must be a number`);
            return n;
        }
        case OptionType.BOOLEAN:
            return value === "true";
    }
    if (SNOWFLAKE_TYPES.has(opt.type)) {
        // Mentions (<@123>, <#123>, <@&123>) or plain IDs
        const id = value.match(/\d{15,21}/)?.[0];
        if (!id) throw new Error(`"${opt.name}": please enter a mention or ID`);
        return id;
    }
    return value;
}

function collectValues(options: CommandOption[], values: Record<string, string>) {
    const out: { type: number; name: string; value: string | number | boolean; }[] = [];
    for (const opt of options) {
        const raw = values[opt.name] ?? "";
        if (!raw.trim()) {
            if (opt.required) throw new Error(`"${opt.name}" is required`);
            continue;
        }
        out.push({ type: opt.type, name: opt.name, value: convert(opt, raw) });
    }
    return out;
}

// ---------------------------------------------------------------- App commands

interface RawCommand {
    id: string;
    application_id: string;
    version: string;
    type: number;
    name: string;
    description: string;
    options?: any[];
}

interface CommandIndex {
    applications?: { id: string; name: string; icon?: string | null; bot?: { avatar?: string | null; }; }[];
    application_commands?: RawCommand[];
}

async function fetchIndex(url: string): Promise<CommandIndex> {
    try {
        const { body } = await RestAPI.get({ url });
        return body ?? {};
    } catch (e) {
        logger.warn("Couldn't load command list", url, e);
        return {};
    }
}

function appIcon(app: CommandIndex["applications"] extends (infer A)[] | undefined ? A : never) {
    return app?.icon ? `https://cdn.discordapp.com/app-icons/${app.id}/${app.icon}.webp?size=32` : null;
}

async function sendInteraction(channelId: string, cmd: RawCommand, options: any[]) {
    const channel = ChannelStore.getChannel(channelId);
    const body: Record<string, any> = {
        type: 2,
        application_id: cmd.application_id,
        channel_id: channelId,
        session_id: AuthenticationStore.getSessionId(),
        data: {
            version: cmd.version,
            id: cmd.id,
            name: cmd.name,
            type: cmd.type,
            options,
            application_command: cmd,
            attachments: []
        },
        nonce: SnowflakeUtils.fromTimestamp(Date.now()),
        analytics_location: "slash_ui"
    };
    if (channel?.guild_id) body.guild_id = channel.guild_id;
    await RestAPI.post({ url: "/interactions", body });
}

/** Resolve subcommands and groups into individual, directly runnable entries */
function flatten(channelId: string, cmd: RawCommand, source: string, icon: string | null): PopoutCommand[] {
    const make = (path: string[], description: string, options: any[], wrap: (opts: any[]) => any[]): PopoutCommand => {
        const opts: CommandOption[] = options ?? [];
        const needsFile = opts.some(o => o.type === OptionType.ATTACHMENT && o.required);
        return {
            key: `${cmd.id}:${path.join(" ")}`,
            name: path.join(" "),
            description,
            source,
            icon,
            options: opts.filter(o => o.type !== OptionType.ATTACHMENT),
            unsupported: needsFile ? "Needs a file upload – please run it in the main window." : undefined,
            run: values => sendInteraction(channelId, cmd, wrap(collectValues(opts.filter(o => o.type !== OptionType.ATTACHMENT), values)))
        };
    };

    const top = cmd.options ?? [];
    const subs = top.filter(o => o.type === OptionType.SUB_COMMAND || o.type === OptionType.SUB_COMMAND_GROUP);
    if (!subs.length) return [make([cmd.name], cmd.description, top, o => o)];

    const out: PopoutCommand[] = [];
    for (const sub of subs) {
        if (sub.type === OptionType.SUB_COMMAND) {
            out.push(make([cmd.name, sub.name], sub.description, sub.options, o => [{ type: OptionType.SUB_COMMAND, name: sub.name, options: o }]));
        } else {
            for (const inner of sub.options ?? []) {
                out.push(make([cmd.name, sub.name, inner.name], inner.description, inner.options, o => [{
                    type: OptionType.SUB_COMMAND_GROUP, name: sub.name, options: [{ type: OptionType.SUB_COMMAND, name: inner.name, options: o }]
                }]));
            }
        }
    }
    return out;
}

async function loadAppCommands(channelId: string): Promise<PopoutCommand[]> {
    const channel = ChannelStore.getChannel(channelId);
    const indexes = channel?.guild_id
        ? await Promise.all([fetchIndex(`/guilds/${channel.guild_id}/application-command-index`), fetchIndex("/users/@me/application-command-index")])
        : [await fetchIndex(`/channels/${channelId}/application-command-index`)];

    const apps = new Map<string, { name: string; icon: string | null; }>();
    const seen = new Set<string>();
    const out: PopoutCommand[] = [];

    for (const index of indexes) {
        for (const app of index.applications ?? []) apps.set(app.id, { name: app.name, icon: appIcon(app) });
    }
    for (const index of indexes) {
        for (const cmd of index.application_commands ?? []) {
            if (cmd.type !== 1 || seen.has(cmd.id)) continue;
            seen.add(cmd.id);
            const app = apps.get(cmd.application_id);
            out.push(...flatten(channelId, cmd, app?.name ?? "App", app?.icon ?? null));
        }
    }
    return out;
}

// ---------------------------------------------------------------- Vencord commands

function loadVencordCommands(channelId: string): PopoutCommand[] {
    return Object.values(vencordCommands)
        .filter(c => c.isVencordCommand && c.name)
        .map(c => {
            const options = ((c.options ?? []) as any[]).filter(o => o.type !== OptionType.SUB_COMMAND && o.type !== OptionType.SUB_COMMAND_GROUP) as CommandOption[];
            return {
                key: `vencord:${c.name}`,
                name: c.name,
                description: c.description ?? "",
                source: "Vencord",
                icon: null,
                options,
                async run(values: Record<string, string>) {
                    const channel = ChannelStore.getChannel(channelId);
                    const args = collectValues(options, values).map(a => ({ ...a, focused: undefined }));
                    const res: any = await c.execute(args as any, { channel, guild: channel?.guild_id ? GuildStore.getGuild(channel.guild_id) : undefined } as any);
                    // Commands like /shrug return text that is then sent
                    if (res?.content) await sendMessage(channelId, { content: res.content }, false);
                }
            };
        });
}

// ---------------------------------------------------------------- Cache

const cache = new Map<string, { at: number; list: Promise<PopoutCommand[]>; }>();
const TTL = 5 * 60 * 1000;

export function getCommands(channelId: string): Promise<PopoutCommand[]> {
    const hit = cache.get(channelId);
    if (hit && Date.now() - hit.at < TTL) return hit.list;

    const list = loadAppCommands(channelId)
        .then(apps => [...apps, ...loadVencordCommands(channelId)])
        .then(all => all.sort((a, b) => a.name.localeCompare(b.name)));
    cache.set(channelId, { at: Date.now(), list });
    list.catch(() => cache.delete(channelId));
    return list;
}

/** Matches for the input after "/" – name prefix matches first */
export function matchCommands(list: PopoutCommand[], query: string) {
    const q = query.trim().toLowerCase();
    if (!q) return list.slice(0, 50);
    const starts = list.filter(c => c.name.toLowerCase().startsWith(q));
    const contains = list.filter(c => !c.name.toLowerCase().startsWith(q) && (c.name.toLowerCase().includes(q) || c.source.toLowerCase().includes(q)));
    return [...starts, ...contains].slice(0, 50);
}
