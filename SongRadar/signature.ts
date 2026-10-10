/*
 * SongRadar – audio fingerprint in Shazam's format.
 * Port of SongRec's signature generator (https://github.com/marin-m/SongRec, GPL-3.0, src/core/fingerprinting):
 * 16 kHz mono audio → FFT every 128 samples (2048 Hann window) → spectral peaks in 4 frequency bands →
 * Shazam's binary signature, sent as a data: URI. Runs in a few milliseconds for 12 seconds of audio.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const SAMPLE_RATE = 16000;
/** Shazam doesn't need more than this, SongRec sends 12 s too */
export const MAX_SECONDS = 12;

const FFT_SIZE = 2048;
const BINS = 1025;

// ---------------------------------------------------------------- FFT (radix-2, 2048 points)

const HANN = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) HANN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * (i + 1) / (FFT_SIZE + 1)));

const BITREV = new Uint16Array(FFT_SIZE);
for (let i = 0, bits = Math.log2(FFT_SIZE); i < FFT_SIZE; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    BITREV[i] = r;
}

const COS = new Float64Array(FFT_SIZE / 2);
const SIN = new Float64Array(FFT_SIZE / 2);
for (let i = 0; i < FFT_SIZE / 2; i++) {
    COS[i] = Math.cos(-2 * Math.PI * i / FFT_SIZE);
    SIN[i] = Math.sin(-2 * Math.PI * i / FFT_SIZE);
}

const re = new Float64Array(FFT_SIZE);
const im = new Float64Array(FFT_SIZE);

/** In-place FFT of a real input; writes |X|² / 2^17 (at least 1e-10) of the first 1025 bins into out */
function powerSpectrum(input: Float32Array, out: Float32Array) {
    for (let i = 0; i < FFT_SIZE; i++) {
        re[BITREV[i]] = input[i];
        im[BITREV[i]] = 0;
    }
    for (let size = 2; size <= FFT_SIZE; size <<= 1) {
        const half = size >> 1, step = FFT_SIZE / size;
        for (let start = 0; start < FFT_SIZE; start += size) {
            for (let k = 0; k < half; k++) {
                const a = start + k, b = a + half;
                const wr = COS[k * step], wi = SIN[k * step];
                const tr = re[b] * wr - im[b] * wi;
                const ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
    }
    for (let i = 0; i < BINS; i++) out[i] = Math.max((re[i] * re[i] + im[i] * im[i]) / (1 << 17), 1e-10);
}

// ---------------------------------------------------------------- Peaks

interface Peak {
    pass: number;
    magnitude: number;
    bin: number;
}

const NEIGHBORS = [-10, -7, -4, -3, 1, 2, 5, 8];
const OTHER_FFTS = [-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249];

const mag = (x: number) => Math.max(Math.log(x), 1 / 64) * 1477.3 + 6144;

function bandOf(hz: number) {
    if (hz >= 250 && hz < 520) return 0;
    if (hz >= 520 && hz < 1450) return 1;
    if (hz >= 1450 && hz < 3500) return 2;
    if (hz >= 3500 && hz <= 5500) return 3;
    return -1;
}

/** Spectral peaks of 16 kHz mono samples (-1..1), exactly like SongRec's SignatureGenerator */
function findPeaks(samples: Float32Array): Peak[][] {
    const bands: Peak[][] = [[], [], [], []];

    const ring = new Int16Array(FFT_SIZE);
    let ringIndex = 0;
    const windowed = new Float32Array(FFT_SIZE);

    const ffts = Array.from({ length: 256 }, () => new Float32Array(BINS));
    let fftIndex = 0;
    const spread = Array.from({ length: 256 }, () => new Float32Array(BINS));
    let spreadIndex = 0;
    let spreadDone = 0;

    const chunks = Math.floor(samples.length / 128);
    for (let c = 0; c < chunks; c++) {
        // ---- FFT of the newest 2048 samples
        for (let i = 0; i < 128; i++) {
            const s = samples[c * 128 + i] * 32768;
            ring[ringIndex + i] = Math.max(-32768, Math.min(32767, Math.trunc(s)));
        }
        ringIndex = (ringIndex + 128) & 2047;
        for (let i = 0; i < FFT_SIZE; i++) windowed[i] = ring[(i + ringIndex) & 2047] * HANN[i];
        powerSpectrum(windowed, ffts[fftIndex]);
        fftIndex = (fftIndex + 1) & 255;

        // ---- Spread peaks over frequency, then back in time
        const latest = ffts[(fftIndex - 1) & 255];
        const current = spread[spreadIndex];
        current.set(latest);
        for (let p = 0; p <= 1022; p++) current[p] = Math.max(current[p], current[p + 1], current[p + 2]);
        for (const back of [1, 3, 6]) {
            const former = spread[(spreadIndex - back) & 255];
            for (let p = 0; p < BINS; p++) if (current[p] > former[p]) former[p] = current[p];
        }
        spreadIndex = (spreadIndex + 1) & 255;
        spreadDone++;

        if (spreadDone < 46) continue;

        // ---- Peak recognition on the FFT 46 steps back
        const f46 = ffts[(fftIndex - 46) & 255];
        const f49 = spread[(spreadIndex - 49) & 255];
        for (let bin = 10; bin <= 1014; bin++) {
            const value = f46[bin];
            if (value < 1 / 64 || value < f49[bin - 1]) continue;

            let maxNeighbor = 0;
            for (const o of NEIGHBORS) maxNeighbor = Math.max(maxNeighbor, f49[bin + o]);
            if (value <= maxNeighbor) continue;

            let maxOther = maxNeighbor;
            for (const o of OTHER_FFTS) maxOther = Math.max(maxOther, spread[(spreadIndex + o) & 255][bin - 1]);
            if (value <= maxOther) continue;

            const m = mag(value), before = mag(f46[bin - 1]), after = mag(f46[bin + 1]);
            const variation1 = m * 2 - before - after;
            const variation2 = (after - before) * 32 / variation1;
            const correctedBin = (bin * 64 + Math.trunc(variation2)) & 0xffff;
            const band = bandOf(Math.trunc(correctedBin * (SAMPLE_RATE / 2 / 1024 / 64)));
            if (band < 0) continue;

            bands[band].push({ pass: spreadDone - 46, magnitude: Math.trunc(m) & 0xffff, bin: correctedBin });
        }
    }
    return bands;
}

// ---------------------------------------------------------------- Binary format

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes: Uint8Array) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

class Writer {
    bytes: number[] = [];
    u8(v: number) { this.bytes.push(v & 0xff); }
    u16(v: number) { this.u8(v); this.u8(v >>> 8); }
    u32(v: number) { this.u16(v & 0xffff); this.u16(v >>> 16); }
}

function encode(bands: Peak[][], sampleCount: number): Uint8Array {
    const w = new Writer();
    w.u32(0xcafe2580);
    w.u32(0); // crc32, filled in below
    w.u32(0); // size minus header, filled in below
    w.u32(0x94119c00);
    w.u32(0); w.u32(0); w.u32(0);
    w.u32(3 << 27); // 16000 Hz
    w.u32(0); w.u32(0);
    w.u32(sampleCount + Math.trunc(SAMPLE_RATE * 0.24));
    w.u32((15 << 19) + 0x40000);
    w.u32(0x40000000);
    w.u32(0); // size minus header, filled in below

    bands.forEach((peaks, band) => {
        if (!peaks.length) return;
        const p = new Writer();
        let pass = 0;
        for (const peak of peaks) {
            if (peak.pass - pass >= 255) {
                p.u8(0xff);
                p.u32(peak.pass);
                pass = peak.pass;
            }
            p.u8(peak.pass - pass);
            p.u16(peak.magnitude);
            p.u16(peak.bin);
            pass = peak.pass;
        }
        w.u32(0x60030040 + band);
        w.u32(p.bytes.length);
        w.bytes.push(...p.bytes);
        for (let i = 0; i < (4 - p.bytes.length % 4) % 4; i++) w.u8(0);
    });

    const out = new Uint8Array(w.bytes);
    const view = new DataView(out.buffer);
    view.setUint32(8, out.length - 48, true);
    view.setUint32(52, out.length - 48, true);
    view.setUint32(4, crc32(out.subarray(8)), true);
    return out;
}

function base64(bytes: Uint8Array) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

export interface Signature {
    uri: string;
    sampleMs: number;
}

/** Signature of 16 kHz mono samples (the last MAX_SECONDS are used) */
export function makeSignature(samples: Float32Array): Signature {
    const max = MAX_SECONDS * SAMPLE_RATE;
    const used = samples.length > max ? samples.subarray(samples.length - max) : samples;
    const bytes = encode(findPeaks(used), used.length);
    return {
        uri: "data:audio/vnd.shazam.sig;base64," + base64(bytes),
        sampleMs: Math.round(used.length / SAMPLE_RATE * 1000)
    };
}
