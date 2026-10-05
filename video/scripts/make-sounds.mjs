// Synthesizes the ad's soundtrack: a music bed timed to the cut and a set of
// short sound effects, all made from oscillators and noise here, so every
// sound is ours to use (no samples, no licences). Writes 16-bit WAVs to
// public/audio. Run with `npm run sounds`; the render scripts run it first.
//
// The music's beat grid is anchored to the edit: the first downbeat falls on
// frame 85 (scene 01 begins) and beat 44 on frame 740 (the end card), so the
// drop lands on the logo. If the scene lengths in src/Ad.tsx change, update
// CALL_START and END_START below.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SR = 44100;
const FPS = 30;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "audio");

const DURATION = 900 / FPS;
const CALL_START = 85 / FPS;
const END_START = 740 / FPS;
const BEATS_TO_END = 44;
const BEAT = (END_START - CALL_START) / BEATS_TO_END; // ~0.496 s, ~121 BPM
const beatTime = (b) => CALL_START + b * BEAT;

// --- Building blocks --------------------------------------------------------

let seed = 7;
function noise() {
  // xorshift, so every run makes the same file
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) / 4294967296) * 2 - 1;
}

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// RBJ biquad.
class Biquad {
  constructor(type, freq, q = 0.707) {
    this.type = type;
    this.q = q;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.set(freq);
  }
  set(freq) {
    const w = (2 * Math.PI * Math.min(freq, SR * 0.45)) / SR;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * this.q);
    let b0, b1, b2;
    if (this.type === "lowpass") [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
    else if (this.type === "highpass") [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
    else [b0, b1, b2] = [alpha, 0, -alpha]; // bandpass, 0 dB peak
    const a0 = 1 + alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

// A small Schroeder/Freeverb-style room, stereo by offsetting the delays.
function reverb(left, right, { wet = 0.25, size = 0.82, damp = 0.35 } = {}) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356];
  const passes = [556, 441, 341];
  const side = (input, spread) => {
    const out = new Float32Array(input.length);
    const cs = combs.map((d) => ({ buf: new Float32Array(d + spread), i: 0, lp: 0 }));
    const as = passes.map((d) => ({ buf: new Float32Array(d + spread), i: 0 }));
    for (let n = 0; n < input.length; n++) {
      const x = input[n] * 0.015;
      let y = 0;
      for (const c of cs) {
        const v = c.buf[c.i];
        c.lp = v * (1 - damp) + c.lp * damp;
        c.buf[c.i] = x + c.lp * size;
        c.i = (c.i + 1) % c.buf.length;
        y += v;
      }
      for (const a of as) {
        const v = a.buf[a.i];
        a.buf[a.i] = y + v * 0.5;
        a.i = (a.i + 1) % a.buf.length;
        y = v - y;
      }
      out[n] = y;
    }
    return out;
  };
  const wl = side(left, 0);
  const wr = side(right, 23);
  for (let n = 0; n < left.length; n++) {
    left[n] += wl[n] * wet * 3;
    right[n] += wr[n] * wet * 3;
  }
}

function stereo(seconds) {
  const n = Math.ceil(seconds * SR);
  return [new Float32Array(n), new Float32Array(n)];
}

// Adds a mono signal into a stereo buffer at `t` seconds, with gain and pan (-1..1).
function mix([L, R], t, mono, gain = 1, pan = 0) {
  const start = Math.round(t * SR);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < mono.length; i++) {
    const j = start + i;
    if (j < 0 || j >= L.length) continue;
    L[j] += mono[i] * gl;
    R[j] += mono[i] * gr;
  }
}

// Renders `fn(t, i)` for `seconds` into a mono buffer.
function render(seconds, fn) {
  const out = new Float32Array(Math.ceil(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = fn(i / SR, i);
  return out;
}

const saw = (phase) => 2 * (phase - Math.floor(phase + 0.5));
const tri = (phase) => 1 - 4 * Math.abs(phase - Math.floor(phase + 0.5));

function writeWav(name, [L, R], peak = 0.89) {
  let max = 1e-9;
  for (let i = 0; i < L.length; i++) max = Math.max(max, Math.abs(L[i]), Math.abs(R[i]));
  const scale = peak / max;
  const data = Buffer.alloc(L.length * 4);
  for (let i = 0; i < L.length; i++) {
    data.writeInt16LE(Math.round(Math.tanh(L[i] * scale * 1.05) * 32767 * 0.97), i * 4);
    data.writeInt16LE(Math.round(Math.tanh(R[i] * scale * 1.05) * 32767 * 0.97), i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(join(OUT, `${name}.wav`), Buffer.concat([header, data]));
}

// --- Instruments ------------------------------------------------------------

function kick(gain = 1) {
  let phase = 0;
  return render(0.45, (t) => {
    const f = 46 + 120 * Math.exp(-t / 0.035);
    phase += f / SR;
    const body = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.22);
    const click = noise() * Math.exp(-t / 0.004) * 0.3;
    return (body + click) * gain;
  });
}

function hat(open = false) {
  const hp = new Biquad("highpass", 7500, 0.9);
  return render(open ? 0.25 : 0.06, (t) => hp.run(noise()) * Math.exp(-t / (open ? 0.08 : 0.018)));
}

function clap() {
  const bp = new Biquad("bandpass", 1400, 1.2);
  return render(0.3, (t) => {
    const bursts = [0, 0.011, 0.022].reduce((a, s) => a + (t >= s ? Math.exp(-(t - s) / 0.006) : 0), 0);
    const tail = Math.exp(-t / 0.09);
    return bp.run(noise()) * (bursts * 0.6 + tail) * 1.6;
  });
}

function bassNote(note, seconds) {
  const f = midi(note);
  const lp = new Biquad("lowpass", 420, 0.9);
  return render(seconds + 0.05, (t) => {
    const env = Math.min(1, t / 0.006) * Math.exp(-t / Math.max(0.12, seconds * 0.7)) * (t > seconds ? Math.exp(-(t - seconds) / 0.02) : 1);
    const x = Math.sin(2 * Math.PI * f * t) * 0.8 + tri(f * t) * 0.35 + saw(f * t) * 0.18;
    return lp.run(x) * env;
  });
}

function pluck(note, gain = 1) {
  const f = midi(note);
  const lp = new Biquad("lowpass", 4000, 1.4);
  return render(0.5, (t) => {
    lp.set(500 + 4200 * Math.exp(-t / 0.05));
    const x = saw(f * t) * 0.6 + saw(f * 1.004 * t) * 0.4;
    return lp.run(x) * Math.min(1, t / 0.002) * Math.exp(-t / 0.16) * gain;
  });
}

function bell(note, seconds = 1.6, gain = 1) {
  const f = midi(note);
  return render(seconds, (t) => {
    const env = Math.min(1, t / 0.002);
    return (
      env *
      gain *
      (Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.5) +
        Math.sin(2 * Math.PI * f * 2.0 * t) * 0.35 * Math.exp(-t / 0.25) +
        Math.sin(2 * Math.PI * f * 3.01 * t) * 0.18 * Math.exp(-t / 0.12) +
        Math.sin(2 * Math.PI * f * 4.2 * t) * 0.08 * Math.exp(-t / 0.06))
    );
  });
}

function riser(seconds, { from = 300, to = 6000, gain = 1 } = {}) {
  const bp = new Biquad("bandpass", from, 2.5);
  let phase = 0;
  return render(seconds, (t) => {
    const p = t / seconds;
    const f = from * Math.pow(to / from, p * p);
    bp.set(f);
    phase += (f / 8) / SR;
    const env = Math.pow(p, 1.6) * (p > 0.97 ? (1 - p) / 0.03 : 1);
    return (bp.run(noise()) * 1.4 + saw(phase) * 0.12) * env * gain;
  });
}

// --- Music bed --------------------------------------------------------------

const CHORDS = {
  Am: { bass: 33, pad: [57, 60, 64, 71] },
  F: { bass: 29, pad: [53, 57, 60, 64] },
  C: { bass: 36, pad: [55, 60, 64, 74] },
  G: { bass: 31, pad: [55, 59, 62, 69] },
};
// [first beat, chord]; the hook (before beat 0) sits on Am, the breakdown on
// G leading into the drop on Am at beat 44.
const TIMELINE = [
  [-8, "Am"],
  [0, "F"],
  [8, "C"],
  [16, "G"],
  [24, "Am"],
  [32, "F"],
  [40, "G"],
  [44, "Am"],
  [48, "F"],
  [52, "Am"],
];
const chordAt = (b) => {
  let c = TIMELINE[0][1];
  for (const [start, name] of TIMELINE) if (b >= start) c = name;
  return CHORDS[c];
};

// Sections, in beats from the first downbeat.
const GROOVE = [0, 38]; // kick, hats, bass
const CLAPS_FROM = 20; // ~12.8 s, the stock scene
const ARP_FROM = 12;
const BREAK = [38, 44]; // drums out, filter opens, riser into the drop
const OUTRO_GROOVE = [44, 52];
const LAST = 52;

function music() {
  const bed = stereo(DURATION);
  const pad = stereo(DURATION);

  // Pad: three detuned saws per note, one event per chord block.
  const blocks = TIMELINE.map(([b, name], i) => {
    const start = i === 0 ? 0 : beatTime(b);
    const end = i + 1 < TIMELINE.length ? beatTime(TIMELINE[i + 1][0]) : DURATION;
    return { start, end, chord: CHORDS[name] };
  });
  for (const { start, end, chord } of blocks) {
    const len = end - start + 0.8;
    chord.pad.forEach((note, k) => {
      const f = midi(note);
      const ph = [noise(), noise(), noise()];
      const sig = render(len, (t) => {
        const env = Math.min(1, t / 0.35) * (t > end - start ? Math.exp(-(t - (end - start)) / 0.25) : 1);
        return (saw(f * t + ph[0]) + saw(f * 1.004 * t + ph[1]) * 0.8 + saw(f * 0.996 * t + ph[2]) * 0.8) * env * 0.09;
      });
      mix(pad, start, sig, 1, (k - 1.5) * 0.35);
    });
  }
  // The pad's filter follows the arrangement: dark in the hook, open in the
  // groove, sweeping up through the breakdown, darkening as it ends.
  const cutoff = (t) => {
    const b = (t - CALL_START) / BEAT;
    if (b < 0) return 500 + 500 * (t / CALL_START);
    if (b < BREAK[0]) return 1300 + 500 * Math.sin(b / 6);
    if (b < BREAK[1]) return 1300 + 4200 * ((b - BREAK[0]) / (BREAK[1] - BREAK[0])) ** 2;
    if (b < LAST) return 2600;
    return 2600 * Math.exp(-(b - LAST) / 6) + 500;
  };
  for (const ch of pad) {
    const lp = new Biquad("lowpass", 800, 0.8);
    for (let i = 0; i < ch.length; i++) {
      if (i % 64 === 0) lp.set(cutoff(i / SR));
      ch[i] = lp.run(ch[i]);
    }
  }

  const drums = stereo(DURATION);
  const bass = stereo(DURATION);
  const kicks = [];
  const inRange = (b, [a, z]) => b >= a && b < z;

  // Opening: a low swell under the first words, and a riser into scene 01.
  mix(bed, 0, render(2.2, (t) => Math.sin(2 * Math.PI * 41 * t) * Math.min(1, t / 0.01) * Math.exp(-t / 0.9) * 0.8), 1);
  mix(bed, CALL_START - 1.1, riser(1.1, { from: 400, to: 5000, gain: 0.45 }));

  for (let b = 0; b < 60; b++) {
    const t = beatTime(b);
    if (t >= DURATION) break;
    const groove = inRange(b, GROOVE) || inRange(b, OUTRO_GROOVE);
    if (groove) {
      kicks.push(t);
      mix(drums, t, kick(0.95));
      mix(drums, t + BEAT / 2, hat(), 0.22, 0.25);
      if (b >= CLAPS_FROM) {
        mix(drums, t + BEAT / 4, hat(), 0.08, -0.3);
        mix(drums, t + (3 * BEAT) / 4, hat(), 0.08, -0.3);
        if (b % 2 === 1) mix(drums, t, clap(), 0.32, 0.05);
      }
      if (b % 8 === 7) mix(drums, t + BEAT / 2, hat(true), 0.16, 0.4);
      const root = chordAt(b).bass;
      mix(bass, t, bassNote(root, BEAT / 2 - 0.03), 0.5);
      mix(bass, t + BEAT / 2, bassNote(b % 2 ? root + 12 : root, BEAT / 2 - 0.03), 0.42);
    }
    if (b >= ARP_FROM && b < BREAK[0]) {
      const notes = chordAt(b).pad.map((n) => n + 12);
      for (let s = 0; s < 4; s++) {
        const note = notes[(b * 4 + s) % notes.length];
        const at = t + (s * BEAT) / 4;
        mix(bed, at, pluck(note, 0.09), 1, s % 2 ? 0.45 : -0.45);
        mix(bed, at + (3 * BEAT) / 4, pluck(note, 0.035), 1, s % 2 ? -0.5 : 0.5); // dotted-eighth echo
      }
    }
  }

  // Breakdown: a held bass note, a snare roll that speeds up, and a riser.
  mix(bass, beatTime(BREAK[0]), bassNote(CHORDS.G.bass, (BREAK[1] - BREAK[0]) * BEAT), 0.35);
  for (let k = 0; k < 24; k++) {
    const p = k / 24;
    const at = beatTime(BREAK[1] - 2) + 2 * BEAT * (1 - Math.pow(1 - p, 1.6));
    mix(drums, at, clap(), 0.06 + 0.22 * p, 0);
  }
  mix(bed, beatTime(BREAK[0] + 2), riser(4 * BEAT, { from: 300, to: 9000, gain: 0.5 }));

  // The drop on the end card: kick, crash and a bell over the logo.
  const crashHp = new Biquad("highpass", 3500, 0.7);
  mix(drums, END_START, render(2.5, (t) => crashHp.run(noise()) * Math.exp(-t / 0.7)), 0.3, 0);
  mix(drums, END_START, kick(1.2));
  mix(bed, END_START, render(3, (t) => Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t / 1.2) * Math.min(1, t / 0.005)), 0.5);

  // Last chord: drums out, a bell on the root.
  mix(bed, beatTime(LAST), bell(81, 3, 0.25), 1, 0.2);
  mix(bed, beatTime(LAST), bell(76, 3, 0.18), 1, -0.2);

  // Sidechain: the pad and bass duck under each kick.
  const duck = new Float32Array(pad[0].length).fill(1);
  for (const k of kicks) {
    const s = Math.round(k * SR);
    for (let i = 0; i < SR * 0.3 && s + i < duck.length; i++) duck[s + i] = Math.min(duck[s + i], 1 - 0.55 * Math.exp(-i / SR / 0.1));
  }
  reverb(pad[0], pad[1], { wet: 0.35, size: 0.86 });
  reverb(bed[0], bed[1], { wet: 0.22 });
  for (let i = 0; i < duck.length; i++) {
    for (const c of [0, 1]) bed[c][i] += pad[c][i] * duck[i] * 0.9 + bass[c][i] * duck[i] * 0.9 + drums[c][i];
  }
  // Fade in over the first frames and out over the last second and a half.
  for (let i = 0; i < duck.length; i++) {
    const t = i / SR;
    const g = Math.min(1, t / 0.05) * Math.min(1, Math.max(0, (DURATION - t) / 1.5));
    bed[0][i] *= g;
    bed[1][i] *= g;
  }
  return bed;
}

// --- Sound effects ----------------------------------------------------------

function fx(seconds, fn, { wet = 0.15 } = {}) {
  const mono = render(seconds, fn);
  const out = stereo(seconds);
  mix(out, 0, mono);
  if (wet) reverb(out[0], out[1], { wet, size: 0.7 });
  return out;
}

function pop(f0) {
  let phase = 0;
  return fx(0.25, (t) => {
    const f = f0 * (1 + 1.2 * Math.exp(-t / 0.012));
    phase += f / SR;
    return Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.05) + noise() * Math.exp(-t / 0.003) * 0.15;
  });
}

function notes(list, { gap = 0.07, decay = 0.9, gain = 1 } = {}) {
  const out = stereo(list.length * gap + decay + 0.6);
  list.forEach((n, i) => mix(out, i * gap, bell(n, decay + 0.4, gain), 1, (i - (list.length - 1) / 2) * 0.3));
  reverb(out[0], out[1], { wet: 0.3, size: 0.8 });
  return out;
}

function sweep(seconds, from, to, q = 1.5) {
  const bp = new Biquad("bandpass", from, q);
  return fx(seconds, (t) => {
    const p = t / seconds;
    bp.set(from * Math.pow(to / from, Math.sin((p * Math.PI) / 2)));
    return bp.run(noise()) * Math.sin(Math.PI * p) ** 1.5 * 1.6;
  }, { wet: 0.2 });
}

const EFFECTS = {
  // Interface
  click: () => {
    const hp = new Biquad("highpass", 1800);
    return fx(0.12, (t) => (hp.run(noise()) * Math.exp(-t / 0.004) + Math.sin(2 * Math.PI * 2400 * t) * Math.exp(-t / 0.012) * 0.5), { wet: 0.08 });
  },
  tick: () => {
    const hp = new Biquad("highpass", 3000);
    return fx(0.06, (t) => hp.run(noise()) * Math.exp(-t / 0.003) + Math.sin(2 * Math.PI * 3600 * t) * Math.exp(-t / 0.006) * 0.3, { wet: 0.05 });
  },
  typing: () => {
    // 44 frames of keystrokes, uneven like a person typing.
    const out = stereo(1.6);
    let t = 0;
    while (t < 1.45) {
      const hp = new Biquad("bandpass", 2500 + noise() * 900, 1.2);
      mix(out, t, render(0.05, (s) => hp.run(noise()) * Math.exp(-s / 0.006)), 0.6 + 0.4 * Math.abs(noise()), noise() * 0.3);
      t += 0.045 + Math.abs(noise()) * 0.05;
    }
    return out;
  },
  pop1: () => pop(520),
  pop2: () => pop(620),
  pop3: () => pop(740),
  blip: () => pop(900),
  // Verdicts and results
  good: () => notes([88, 95], { gap: 0.06, decay: 0.6, gain: 0.8 }), // E6 B6
  bad: () => {
    let phase = 0;
    return fx(0.35, (t) => {
      const f = t < 0.09 ? 311 : 233;
      phase += f / SR;
      return (tri(phase) * 0.8 + saw(phase) * 0.15) * Math.min(1, t / 0.003) * Math.exp(-t / 0.14);
    }, { wet: 0.12 });
  },
  warn: () => notes([76], { decay: 0.4, gain: 0.7 }),
  stamp: () => {
    let phase = 0;
    const lp = new Biquad("lowpass", 1200);
    return fx(0.7, (t) => {
      const f = 42 + 110 * Math.exp(-t / 0.03);
      phase += f / SR;
      return Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.18) * 1.1 + lp.run(noise()) * Math.exp(-t / 0.025) * 0.7;
    }, { wet: 0.25 });
  },
  notify: () => notes([81, 88], { gap: 0.11, decay: 0.8 }), // A5 E6
  success: () => notes([84, 88, 91, 96], { gap: 0.06, decay: 0.9, gain: 0.8 }), // C6 E6 G6 C7
  // Movement
  whoosh: () => sweep(0.55, 250, 3500, 1.2),
  swish: () => sweep(0.38, 900, 7000, 1.8),
  shimmer: () => {
    const out = stereo(1.6);
    [69, 76, 81, 83, 88, 93].forEach((n, i) => mix(out, i * 0.13, bell(n, 0.9, 0.35), 1, i % 2 ? 0.4 : -0.4));
    reverb(out[0], out[1], { wet: 0.4, size: 0.85 });
    return out;
  },
  lock: () => {
    const out = notes([69, 76, 81], { gap: 0.0, decay: 1.6, gain: 0.7 });
    let phase = 0;
    mix(out, 0, render(0.4, (t) => {
      phase += (60 + 90 * Math.exp(-t / 0.02)) / SR;
      return Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.12);
    }), 0.8);
    return out;
  },
};

mkdirSync(OUT, { recursive: true });
writeWav("music", music(), 0.85);
for (const [name, make] of Object.entries(EFFECTS)) writeWav(name, make(), 0.8);
console.log(`Wrote music.wav (${BEAT.toFixed(4)} s a beat, ${(60 / BEAT).toFixed(1)} BPM) and ${Object.keys(EFFECTS).length} effects to public/audio`);
