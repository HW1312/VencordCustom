import assert from "node:assert/strict";
import test from "node:test";
import { selectCover, safeCoverUrl, trackKey } from "../artwork.ts";
import { createPresence } from "../presence.ts";

const cover = "https://cdn-images.dzcdn.net/images/cover/0123456789abcdef0123456789abcdef/1000x1000-000000-80-0-0.jpg";
const otherCover = cover.replace("0123456789abcdef0123456789abcdef", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const track = { title: "A Song - Remix", artist: "An Artist", album: "An Album", durationMs: 180500 };
const row = { title: "A Song (Remix)", artist: { name: "An Artist" }, album: { title: "An Album", cover_xl: cover }, duration: 180 };

test("matches remix punctuation, artist and recording duration", () => {
    assert.equal(selectCover(track, { data: [row] }), cover);
});
test("rejects original versions, other artists, wrong durations and unsafe hosts", () => {
    for (const change of [{ title: "A Song" }, { artist: { name: "Someone Else" } }, { duration: 280 },
        { album: { title: "An Album", cover_xl: "https://evil.example/cover.jpg" } }]) {
        assert.equal(selectCover(track, { data: [{ ...row, ...change }] }), null);
    }
});
test("prefers the source album over compilations", () => {
    const compilation = { ...row, album: { title: "Compilation", cover_xl: otherCover } };
    assert.equal(selectCover(track, { data: [compilation, row] }), cover);
});
test("cover links must use the specific HTTPS image CDN with no credentials", () => {
    for (const url of ["http://cdn-images.dzcdn.net/images/cover/test", "data:image/png;base64,test",
        "https://cdn-images.dzcdn.net.evil.example/images/cover/test", cover.replace("https://", "https://user@"),
        cover.replace("cdn-images.dzcdn.net", "cdn-images.dzcdn.net:444")]) assert.equal(safeCoverUrl(url), null);
    assert.equal(safeCoverUrl(cover), cover);
});
test("unknown results do not invent a cover", () => {
    for (const value of [null, {}, { data: [] }, { data: [null, {}, { title: "broken" }] }]) {
        assert.equal(selectCover(track, value), null);
    }
});
test("track keys distinguish albums and do not collide on separators", () => {
    assert.notEqual(trackKey(track), trackKey({ ...track, album: "Other" }));
    assert.notEqual(trackKey({ title: "a|b", artist: "c", album: "d" }), trackKey({ title: "a", artist: "b|c", album: "d" }));
});
test("resolved cover becomes the large Discord asset without account fields", () => {
    const now = Date.now();
    const activity = createPresence({ ...track, playing: true, positionMs: 10000, observedAt: now }, {
        applicationId: "1528896038163710112", showProgress: true, searchButton: false, coverAsset: "mp:external/resolved-cover"
    }, now);
    assert.deepEqual(activity.assets, { large_image: "mp:external/resolved-cover", large_text: "An Album" });
    assert.ok(!("session_id" in activity));
    assert.ok(!("sync_id" in activity));
});
