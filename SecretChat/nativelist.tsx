/*
 * SecretChat – Message list of the rooms window, drawn with Discord's own message component: avatars (also bots /
 * webhooks), embeds, link cards, stickers, all formatting, the hover bar and Discord's right-click menu work as in
 * Discord. The messages come from Discord's MessageStore, so they went through the decrypting interceptor.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { getUserSettingLazy } from "@api/UserSettings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Channel, Message } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { MessageActions, MessageStore, useEffect, useLayoutEffect, useMemo, useRef, useState, useStateFromStores } from "@webpack/common";

const cl = classNameFactory("vc-secretchat-");

/** Discord's component for one chat message (same one MessageLinkEmbeds uses) */
const ChannelMessage = findComponentByCodeLazy("childrenExecutedCommand:", ".hideAccessories");
const MessageDisplayCompact = getUserSettingLazy("textAndImages", "messageDisplayCompact")!;

/** Like Discord: a new header after 7 minutes or another author */
const GROUP_MS = 7 * 60 * 1000;
const PAGE = 50;

function startsGroup(prev: Message | undefined, m: Message) {
    if (!prev || prev.author?.id !== m.author?.id) return true;
    if (m.type !== 0 || (m as any).messageReference) return true;
    return +new Date(m.timestamp as any) - +new Date(prev.timestamp as any) > GROUP_MS;
}

function dayOf(m: Message) {
    return new Date(m.timestamp as any).toDateString();
}

export function NativeMessageList({ channel, hide }: { channel: Channel; hide(m: Message): boolean; }) {
    const channelId = channel.id;
    const compact = MessageDisplayCompact.useSetting();
    const store = useStateFromStores([MessageStore], () => MessageStore.getMessages(channelId), [channelId]);
    const all: Message[] = (store as any)?._array ?? [];
    const list = useMemo(() => all.filter(m => !hide(m)), [all]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const atBottom = useRef(true);
    const olderAnchor = useRef<number | null>(null);
    const [requested, setRequested] = useState(false);

    // Discord only loads the messages of the chat you have open – load this one ourselves
    useEffect(() => {
        if (!store?.ready || !all.length) {
            MessageActions.fetchMessages({ channelId, limit: PAGE });
        }
        setRequested(true);
    }, [channelId]);

    // Stay at the bottom when new messages come in; keep the position when older ones are added on top
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        if (olderAnchor.current != null) {
            el.scrollTop = el.scrollHeight - olderAnchor.current;
            olderAnchor.current = null;
        } else if (atBottom.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [list]);

    // Images load after the first render – keep sticking to the bottom while they do
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const content = el.firstElementChild;
        if (!content) return;
        const ro = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; });
        ro.observe(content);
        return () => ro.disconnect();
    }, []);

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (el.scrollTop < 300 && store?.hasMoreBefore && !store.loadingMore && all.length) {
            olderAnchor.current = el.scrollHeight - el.scrollTop;
            MessageActions.fetchMessages({ channelId, before: all[0].id, limit: PAGE });
        }
    };

    let groupId = "";
    return (
        <div className={cl("native-wrap")} data-native-messages="">
            <div className={cl("native-list")} ref={scrollRef} onScroll={onScroll}>
                <div className={cl("native-content")}>
                    {store?.hasMoreBefore === false && <div className={cl("native-start")}>Beginning of the chat</div>}
                    {store?.loadingMore && <div className={cl("native-start")}>Loading …</div>}
                    {!list.length && requested && store?.ready && <div className={cl("native-start")}>No messages yet – say hi</div>}
                    {list.map((m, i) => {
                        const prev = list[i - 1];
                        const newDay = !prev || dayOf(prev) !== dayOf(m);
                        if (newDay || startsGroup(prev, m)) groupId = m.id;
                        return (
                            <ErrorBoundary noop key={m.id}>
                                {newDay && <div className={cl("native-day")}><span>{new Date(m.timestamp as any).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</span></div>}
                                <div className={cl("native-item")}>
                                    <ChannelMessage
                                        id={`vc-secretchat-${m.id}`}
                                        message={m}
                                        channel={channel}
                                        groupId={groupId}
                                        compact={compact}
                                    />
                                </div>
                            </ErrorBoundary>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
