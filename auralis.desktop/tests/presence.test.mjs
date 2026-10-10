import assert from "node:assert/strict";
import test from "node:test";
import { createPresence, decodeTrack } from "../presence.ts";

const now = 1700000000000;
const input = {
    title: "Test Song", artist: "Test Artist", album: "Test Album", playing: true,
    positionMs: 30000, durationMs: 180000, observedAt: now,
    accountName: "private-user", spotifyId: "private-id", sessionId: "private-session",
    token: "private-token", profileUrl: "https://open.spotify.com/user/private-user"
};
const options = { applicationId: "123456789012345678", showProgress: true, searchButton: false };

test("untrusted metadata cannot leak account fields into presence", () => {
    const track = decodeTrack(input, now);
    assert.deepEqual(Object.keys(track).sort(), ["album", "artist", "durationMs", "observedAt", "playing", "positionMs", "title"].sort());
    const activity = createPresence(track, options, now);
    assert.deepEqual(Object.keys(activity).sort(), ["application_id", "details", "flags", "name", "state", "timestamps", "type"].sort());
    assert.ok(!JSON.stringify(activity).includes("private-"));
    assert.equal(activity.details, "Test Song");
    assert.equal(activity.state, "Test Artist");
});

test("paused, missing, stale or unconfigured playback clears activity", () => {
    const track = decodeTrack(input, now);
    assert.equal(createPresence({ ...track, playing: false }, options, now), null);
    assert.equal(createPresence(null, options, now), null);
    assert.equal(createPresence(track, options, now + 16000), null);
    assert.equal(createPresence(track, { ...options, applicationId: "" }, now), null);
});

test("progress anchors to observation time and keeps the song end stable", () => {
    const track = decodeTrack(input, now);
    const activity = createPresence(track, options, now + 5000);
    assert.deepEqual(activity.timestamps, { start: now - 30000, end: now + 150000 });
    assert.ok(!("timestamps" in createPresence(track, { ...options, showProgress: false }, now)));
    assert.ok(!("timestamps" in createPresence({ ...track, durationMs: 0 }, options, now)));
});

test("seek updates timestamps", () => {
    const track = decodeTrack({ ...input, positionMs: 90000 }, now);
    assert.equal(createPresence(track, options, now).timestamps.start, now - 90000);
});

test("invalid and outdated native snapshots fail closed", () => {
    for (const patch of [{ title: "" }, { playing: "true" }, { positionMs: -1 }, { durationMs: NaN },
        { observedAt: now - 16000 }, { observedAt: now + 6000 }, { artist: null }]) {
        assert.equal(decodeTrack({ ...input, ...patch }, now), null);
    }
    assert.equal(decodeTrack(null, now), null);
    assert.equal(decodeTrack({ ...input, positionMs: 999999 }, now).positionMs, 180000);
});

test("optional search URL encodes only song metadata", () => {
    const track = decodeTrack({ ...input, title: "A/B & C?" }, now);
    const activity = createPresence(track, { ...options, searchButton: true }, now);
    const url = new URL(activity.metadata.button_urls[0]);
    assert.equal(url.origin, "https://open.spotify.com");
    assert.equal(decodeURIComponent(url.pathname), "/search/A/B & C? Test Artist");
    assert.ok(!JSON.stringify(activity).includes("private-"));
});
