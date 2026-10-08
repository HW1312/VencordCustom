/*
 * SecretChat – Chat bar lock, keyring window (1:1 / Group tabs), handshake card and lock icon on messages
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { copyWithToast } from "@utils/discord";
import { classes } from "@utils/misc";
import { IconComponent } from "@utils/types";
import { Channel, Message, RenderModalProps } from "@vencord/discord-types";
import { Alerts, Modal, openModal, showToast, Toasts, Tooltip, UserStore, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { keyFromPassword, randomBytes } from "./crypto";
import { acceptHandshake, decrypted, handshakes, ignoreHandshake, retryLocked, startHandshake } from "./messages";
import { settings } from "./settings";
import { addKey, channelKey, deleteKey, getKey, inviteCode, KeyRecord, parseInviteCode, renameKey, setChannelKey, toggleChannel, useStore } from "./store";

const cl = classNameFactory("vc-secretchat-");

// ---------------------------------------------------------------- Icons

export const LockIcon: IconComponent = ({ width = 24, height = 24, className }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className} fill="currentColor">
        <path fillRule="evenodd" d="M6 9V7a6 6 0 1 1 12 0v2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h1Zm2-2a4 4 0 1 1 8 0v2H8V7Zm4 6a2 2 0 0 0-1 3.73V18a1 1 0 1 0 2 0v-1.27A2 2 0 0 0 12 13Z" />
    </svg>
);

const UnlockIcon: IconComponent = ({ width = 24, height = 24, className }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className} fill="currentColor">
        <path fillRule="evenodd" d="M8 7a4 4 0 0 1 7.75-1.4 1 1 0 1 0 1.87-.7A6 6 0 0 0 6 7v2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2H8V7Zm4 6a2 2 0 0 0-1 3.73V18a1 1 0 1 0 2 0v-1.27A2 2 0 0 0 12 13Z" />
    </svg>
);

const icon = (d: string): IconComponent => ({ width = 16, height = 16, className }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className} fill="currentColor"><path d={d} /></svg>
);

const PersonIcon = icon("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4Z");
const GroupIcon = icon("M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13Zm8 0c-.29 0-.62.02-.97.05A4.22 4.22 0 0 1 17 16.5V19h6v-2.5c0-2.33-4.67-3.5-7-3.5Z");
const CopyIcon = icon("M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z");
const PencilIcon = icon("M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z");
const TrashIcon = icon("M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z");
const CheckIcon = icon("M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17Z");
const PlusIcon = icon("M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z");
const ShieldIcon = icon("M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4Z");

const userName = (id?: string) => {
    const u = id ? UserStore.getUser(id) : null;
    return u ? (u as any).globalName || u.username : "someone";
};

// ---------------------------------------------------------------- Chat bar

export const ChatButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    useStore();
    const { showChatBarButton } = settings.use(["showChatBarButton"]);
    if (!showChatBarButton || !isMainChat || !channel) return null;

    const active = channelKey(channel.id);
    const tooltip = active
        ? `Encrypted with “${active.name}” · right-click to turn off`
        : "SecretChat: off · click to choose a key";

    return (
        <ChatBarButton
            tooltip={tooltip}
            onClick={() => openChatModal(channel)}
            onContextMenu={async e => {
                e.preventDefault();
                const id = await toggleChannel(channel.id);
                if (!id && !active) openChatModal(channel);
            }}
        >
            {active
                ? <LockIcon width={20} height={20} className={cl("bar-on")} />
                : <UnlockIcon width={20} height={20} />}
        </ChatBarButton>
    );
};

// ---------------------------------------------------------------- Small parts

function Avatar({ userId }: { userId?: string; }) {
    const user = userId ? UserStore.getUser(userId) : null;
    const url = (user as any)?.getAvatarURL?.(undefined, 64);
    return url
        ? <img className={cl("avatar")} src={url} alt="" />
        : <span className={cl("avatar")}><PersonIcon width={20} height={20} /></span>;
}

function IconButton({ label, danger, onClick, children }: { label: string; danger?: boolean; onClick(): void; children: ReactNode; }) {
    return (
        <Tooltip text={label}>
            {p => (
                <button {...p} aria-label={label} className={classes(cl("icon-btn"), danger && cl("icon-btn-danger"))} onClick={onClick}>
                    {children}
                </button>
            )}
        </Tooltip>
    );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; }[]; onChange(v: T): void; }) {
    return (
        <div className={cl("segmented")}>
            {options.map(o => (
                <button key={o.value} className={classes(cl("segment"), o.value === value && cl("segment-on"))} onClick={() => onChange(o.value)}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function confirmDelete(k: KeyRecord) {
    Alerts.show({
        title: `Delete “${k.name}”?`,
        body: "Messages sent with this key can't be read on this PC anymore.",
        confirmText: "Delete key",
        cancelText: "Cancel",
        confirmColor: "vc-secretchat-danger-btn",
        onConfirm: () => deleteKey(k.id)
    });
}

// ---------------------------------------------------------------- Window for one chat

function KeyRow({ k, selected, onClick }: { k: KeyRecord; selected: boolean; onClick(): void; }) {
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(k.name);

    return (
        <div className={classes(cl("row"), selected && cl("row-on"))} onClick={() => !editing && onClick()}>
            {k.kind === "private"
                ? <Avatar userId={k.partnerId} />
                : <span className={classes(cl("avatar"), cl("avatar-group"))}><GroupIcon width={20} height={20} /></span>}

            <span className={cl("row-main")}>
                {editing ? (
                    <input
                        className={classes(cl("input"), cl("input-inline"))}
                        value={name}
                        autoFocus
                        maxLength={64}
                        onClick={e => e.stopPropagation()}
                        onChange={e => setName(e.currentTarget.value)}
                        onBlur={() => { renameKey(k.id, name); setEditing(false); }}
                        onKeyDown={e => {
                            if (e.key === "Enter") e.currentTarget.blur();
                            if (e.key === "Escape") { e.stopPropagation(); setName(k.name); setEditing(false); }
                        }}
                    />
                ) : <span className={cl("row-title")}>{k.name}</span>}
                <Tooltip text="Safety code – compare it with the others">
                    {p => <span {...p} className={cl("safety")}><ShieldIcon width={12} height={12} />{k.safety}</span>}
                </Tooltip>
            </span>

            <span className={cl("row-actions")} onClick={e => e.stopPropagation()}>
                <IconButton label="Rename" onClick={() => setEditing(true)}><PencilIcon /></IconButton>
                {k.kind === "group" && (
                    <IconButton label="Copy code" onClick={() => copyWithToast(inviteCode(k), "Code copied")}><CopyIcon /></IconButton>
                )}
                <IconButton label="Delete" danger onClick={() => confirmDelete(k)}><TrashIcon /></IconButton>
            </span>

            <span className={cl("check")}>{selected && <CheckIcon width={14} height={14} />}</span>
        </div>
    );
}

function KeyList({ keys, current, channelId }: { keys: KeyRecord[]; current: string | null; channelId: string; }) {
    if (!keys.length) return null;
    return (
        <div className={cl("rows")}>
            {keys.map(k => (
                <KeyRow key={k.id} k={k} selected={current === k.id} onClick={() => setChannelKey(channelId, current === k.id ? null : k.id)} />
            ))}
        </div>
    );
}

function PrivateTab({ channel, current }: { channel: Channel; current: string | null; }) {
    const s = useStore();
    const me = UserStore.getCurrentUser()?.id;
    const recipients: string[] = (channel.recipients ?? []).filter(id => id !== me);
    const keys = s.keys
        .filter(k => k.kind === "private")
        // People in this chat first
        .sort((a, b) => Number(recipients.includes(b.partnerId!)) - Number(recipients.includes(a.partnerId!)));
    const connected = new Set(keys.map(k => k.partnerId));
    const candidates = recipients.filter(id => !connected.has(id));
    const waiting = new Set(Object.values(s.pending).map(p => p.to));

    return (
        <div className={cl("tab-body")}>
            <KeyList keys={keys} current={current} channelId={channel.id} />

            {candidates.map(id => (
                <button
                    key={id}
                    className={cl("connect")}
                    disabled={waiting.has(id)}
                    onClick={() => {
                        const user = UserStore.getUser(id);
                        if (user) startHandshake(user, channel.id);
                    }}
                >
                    <Avatar userId={id} />
                    <span className={cl("row-title")}>{userName(id)}</span>
                    <span className={cl("connect-label")}>{waiting.has(id) ? "Waiting …" : <><PlusIcon />Connect</>}</span>
                </button>
            ))}

            {!keys.length && !candidates.length && (
                <div className={cl("empty")}>
                    <PersonIcon width={28} height={28} />
                    Right-click someone → Start encrypted chat
                </div>
            )}
        </div>
    );
}

function GroupTab({ channel, current }: { channel: Channel; current: string | null; }) {
    const s = useStore();
    const keys = s.keys.filter(k => k.kind === "group");
    const [panel, setPanel] = useState<"new" | "code" | null>(keys.length ? null : "new");
    const [name, setName] = useState("");
    const [mode, setMode] = useState<"random" | "password">("random");
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);

    const canCreate = !!name.trim() && (mode === "random" || password.length >= 8) && !busy;
    const codeValid = !!parseInviteCode(code);

    const create = async () => {
        if (!canCreate) return;
        setBusy(true);
        try {
            const key = mode === "random" ? randomBytes(32) : await keyFromPassword(password);
            const { record, isNew } = await addKey(key, { name, kind: "group", source: mode });
            await setChannelKey(channel.id, record.id);
            retryLocked();
            if (!isNew) showToast(`You already have this key as “${record.name}”`, Toasts.Type.MESSAGE);
            else if (mode === "random") copyWithToast(inviteCode(record), "Key created – code copied");
            setName("");
            setPassword("");
            setPanel(null);
        } finally {
            setBusy(false);
        }
    };

    const add = async () => {
        if (codeValid && await importCode(code, channel.id)) {
            setCode("");
            setPanel(null);
        }
    };

    return (
        <div className={cl("tab-body")}>
            <KeyList keys={keys} current={current} channelId={channel.id} />

            <div className={cl("actions")}>
                <button className={classes(cl("chip"), panel === "new" && cl("chip-on"))} onClick={() => setPanel(panel === "new" ? null : "new")}>
                    <PlusIcon />New key
                </button>
                <button className={classes(cl("chip"), panel === "code" && cl("chip-on"))} onClick={() => setPanel(panel === "code" ? null : "code")}>
                    <CopyIcon />Paste code
                </button>
            </div>

            {panel === "new" && (
                <div className={cl("panel")}>
                    <input className={cl("input")} value={name} autoFocus placeholder="Name" maxLength={64} onChange={e => setName(e.currentTarget.value)} />
                    <Segmented<"random" | "password">
                        value={mode}
                        onChange={setMode}
                        options={[{ value: "random", label: "Code" }, { value: "password", label: "Password" }]}
                    />
                    {mode === "password" && (
                        <input
                            className={cl("input")}
                            type="password"
                            value={password}
                            placeholder="Password (8+ characters)"
                            onChange={e => setPassword(e.currentTarget.value)}
                            onKeyDown={e => { if (e.key === "Enter") create(); }}
                        />
                    )}
                    <button className={classes(cl("btn"), cl("btn-primary"))} disabled={!canCreate} onClick={create}>
                        {busy ? "Creating …" : "Create"}
                    </button>
                </div>
            )}

            {panel === "code" && (
                <div className={cl("panel")}>
                    <input
                        className={classes(cl("input"), cl("input-mono"), code && !codeValid && cl("input-error"))}
                        value={code}
                        autoFocus
                        placeholder="sckey1.…"
                        onChange={e => setCode(e.currentTarget.value)}
                        onKeyDown={e => { if (e.key === "Enter") add(); }}
                    />
                    <button className={classes(cl("btn"), cl("btn-primary"))} disabled={!codeValid} onClick={add}>Add</button>
                </div>
            )}
        </div>
    );
}

function ChatModal({ modalProps, channel }: { modalProps: RenderModalProps; channel: Channel; }) {
    useStore();
    const active = channelKey(channel.id);
    const [tab, setTab] = useState<"private" | "group">(active ? active.kind : channel.isDM?.() ? "private" : "group");

    const tabs = [
        { id: "private" as const, label: "1:1", Icon: PersonIcon },
        { id: "group" as const, label: "Group", Icon: GroupIcon }
    ];

    return (
        <Modal {...modalProps} size="sm" title="SecretChat">
            <div className={cl("window")}>
                <div className={classes(cl("status"), active && cl("status-on"))}>
                    {active ? <LockIcon width={20} height={20} /> : <UnlockIcon width={20} height={20} />}
                    <span className={cl("status-text")}>
                        {active ? <>Encrypted · <b>{active.name}</b></> : "Not encrypted"}
                    </span>
                    {active && <button className={cl("status-off")} onClick={() => setChannelKey(channel.id, null)}>Turn off</button>}
                </div>

                <div className={cl("tabs")}>
                    {tabs.map(({ id, label, Icon }) => (
                        <button key={id} className={classes(cl("tab"), tab === id && cl("tab-on"))} onClick={() => setTab(id)}>
                            <Icon />
                            {label}
                            {active?.kind === id && <span className={cl("tab-dot")} />}
                        </button>
                    ))}
                </div>

                {tab === "private"
                    ? <PrivateTab channel={channel} current={active?.id ?? null} />
                    : <GroupTab channel={channel} current={active?.id ?? null} />}
            </div>
        </Modal>
    );
}

export function openChatModal(channel: Channel) {
    openModal(props => (
        <ErrorBoundary>
            <ChatModal modalProps={props} channel={channel} />
        </ErrorBoundary>
    ));
}

export async function importCode(text: string, channelId?: string) {
    const parsed = parseInviteCode(text);
    if (!parsed) return null;
    const result = await addKey(parsed.key, { name: parsed.name || "Group key", kind: "group", source: "code" });
    if (channelId) await setChannelKey(channelId, result.record.id);
    retryLocked();
    showToast(result.isNew ? `Key “${result.record.name}” added` : `You already have this key as “${result.record.name}”`, Toasts.Type.SUCCESS);
    return result;
}

// ---------------------------------------------------------------- On messages

/** Lock next to the name of decrypted messages */
export function LockDecoration({ message }: { message: Message; }) {
    useStore();
    const keyId = decrypted.get(message.id);
    if (!keyId || !settings.store.showLockIcon) return null;
    const k = getKey(keyId);
    return (
        <Tooltip text={k ? `Encrypted · ${k.name}` : "Encrypted"}>
            {p => <span {...p} className={cl("deco")}><LockIcon width={14} height={14} /></span>}
        </Tooltip>
    );
}

/** Below handshake messages (accept / waiting) and below decrypted key codes (add key) */
export function MessageCard({ message }: { message: Message; }) {
    const s = useStore();
    const hs = handshakes.get(message.id);
    const me = UserStore.getCurrentUser()?.id;

    if (!hs) {
        if (!decrypted.has(message.id)) return null;
        const code = parseInviteCode(message.content);
        if (!code) return null;
        return (
            <div className={cl("card")}>
                <GroupIcon width={18} height={18} />
                <span className={cl("card-text")}>Group key “{code.name || "Group key"}”</span>
                <button className={classes(cl("btn"), cl("btn-primary"))} onClick={() => importCode(message.content)}>Add key</button>
            </div>
        );
    }

    let text: ReactNode;
    let buttons: ReactNode = null;
    if (hs.type === "hello") {
        if (hs.to === me && !s.handled.includes(hs.hsid)) {
            text = <>{userName(hs.authorId)} wants an encrypted 1:1 chat</>;
            buttons = (
                <>
                    <button className={classes(cl("btn"), cl("btn-primary"))} onClick={() => acceptHandshake(hs)}>Accept</button>
                    <button className={cl("btn")} onClick={() => ignoreHandshake(hs)}>Ignore</button>
                </>
            );
        } else if (hs.to === me) {
            text = <>Request from {userName(hs.authorId)} answered</>;
        } else if (hs.authorId === me) {
            text = s.pending[hs.hsid] ? <>Waiting for {userName(hs.to)} …</> : <>Request to {userName(hs.to)} answered</>;
        } else {
            text = <>Encrypted chat request to {userName(hs.to)}</>;
        }
    } else {
        text = hs.authorId !== me && s.pending[hs.hsid] ? <>Connecting …</> : <>Encrypted 1:1 chat set up</>;
    }

    return (
        <div className={cl("card")}>
            <LockIcon width={18} height={18} />
            <span className={cl("card-text")}>{text}</span>
            {buttons}
        </div>
    );
}
