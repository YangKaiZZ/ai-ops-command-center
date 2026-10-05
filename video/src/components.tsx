import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { color, displayStyle, font, type Tone } from "./theme";
import type { Icon } from "./icons";

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// A spring that starts at `delay` frames, 0 -> 1.
export function useEnter(delay = 0, config: { damping?: number; stiffness?: number; mass?: number } = {}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping: 200, stiffness: 120, ...config } });
}

export function useIsVertical() {
  const { width, height } = useVideoConfig();
  return height > width;
}

// Fade + rise, the default way things arrive.
export function Rise({ delay = 0, distance = 28, children, style }: { delay?: number; distance?: number; children: React.ReactNode; style?: React.CSSProperties }) {
  const p = useEnter(delay);
  return <div style={{ opacity: p, transform: `translateY(${(1 - p) * distance}px)`, ...style }}>{children}</div>;
}

// Ink with a faint dot grid and a slow lime glow, like the sign-in page.
export function Backdrop({ glowX = 0.7, glowY = 0.35 }: { glowX?: number; glowY?: number }) {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 60) * 40;
  return (
    <AbsoluteFill style={{ background: color.page, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(${color.border} 1.2px, transparent 1.2px)`,
          backgroundSize: "36px 36px",
          backgroundPosition: `${-frame * 0.3}px ${-frame * 0.15}px`,
          opacity: 0.55,
          maskImage: "radial-gradient(ellipse 75% 70% at 50% 50%, black 30%, transparent 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: `calc(${glowX * 100}% - 600px + ${drift}px)`,
          top: `calc(${glowY * 100}% - 600px)`,
          width: 1200,
          height: 1200,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(182,255,46,0.10) 0%, rgba(182,255,46,0.03) 40%, transparent 70%)`,
        }}
      />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)" }} />
    </AbsoluteFill>
  );
}

// The mark, "the Caret" (dashboard/src/components/Logo.tsx). `draw` 0 -> 1
// strokes the chevron in; `bar` 0 -> 1 slides the lime crossbar into place.
export function Logo({ size = 64, draw = 1, bar = 1 }: { size?: number; draw?: number; bar?: number }) {
  const length = 86; // the chevron's path length
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} style={{ overflow: "visible" }}>
      <path
        d="M10.5 51 L32 13.8 L53.5 51"
        fill="none"
        stroke={color.ink}
        strokeWidth={9.5}
        strokeLinejoin="miter"
        strokeMiterlimit={4}
        strokeDasharray={length}
        strokeDashoffset={length * (1 - draw)}
      />
      <path
        d="M25.52 39.5H38.48L42.82 47H21.18Z"
        fill={color.accent}
        style={{ opacity: bar, transform: `translateY(${(1 - bar) * 14}px)` }}
      />
    </svg>
  );
}

const TONE: Record<Tone, string> = {
  good: color.good,
  warning: color.warning,
  serious: color.serious,
  critical: color.critical,
  neutral: color.neutral,
};

// The dashboard's status chip: a thin edge and faint fill of the tone, a
// square pip (the crossbar) or an icon, and always a text label.
export function Badge({ label, tone, icon: Glyph, scale = 1, style }: { label: string; tone: Tone; icon?: Icon; scale?: number; style?: React.CSSProperties }) {
  const c = tone === "neutral" ? color.inkSoft : TONE[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8 * scale,
        whiteSpace: "nowrap",
        borderRadius: 8 * scale,
        border: `${1.5 * scale}px solid ${tone === "neutral" ? color.border : hexA(TONE[tone], 0.35)}`,
        background: tone === "neutral" ? "rgba(236,238,230,0.03)" : hexA(TONE[tone], 0.09),
        color: c,
        padding: `${4 * scale}px ${12 * scale}px ${4 * scale}px ${10 * scale}px`,
        fontFamily: font.sans,
        fontWeight: 650,
        fontSize: 17 * scale,
        fontVariantNumeric: "tabular-nums",
        ...style,
      }}
    >
      {Glyph ? <Glyph weight="bold" size={16 * scale} /> : <span style={{ width: 7 * scale, height: 7 * scale, background: "currentColor" }} />}
      {label}
    </span>
  );
}

export function hexA(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export const cardStyle: React.CSSProperties = {
  background: color.surface,
  border: `1.5px solid ${color.border}`,
  borderRadius: 18,
  boxShadow: "0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.4)",
};

// The small label the brand rules ask for: anything that isn't a real
// seller's data is marked as a sample.
export function SampleTag() {
  return (
    <span
      style={{
        fontFamily: font.mono,
        fontSize: 13,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: color.ink2,
        border: `1px dashed ${color.border}`,
        borderRadius: 6,
        padding: "3px 8px",
      }}
    >
      Sample store
    </span>
  );
}

// Words that arrive one after another. Wrap a word in *stars* to set it in lime.
export function StaggerText({ text, delay = 0, every = 3, style }: { text: string; delay?: number; every?: number; style?: React.CSSProperties }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(" ");
  return (
    <span style={{ display: "inline", ...style }}>
      {words.map((raw, i) => {
        const lime = raw.startsWith("*");
        const word = raw.replace(/\*/g, "");
        const p = spring({ frame: frame - delay - i * every, fps, config: { damping: 200, stiffness: 140 } });
        return (
          <span key={i} style={{ display: "inline-block", overflow: "hidden", verticalAlign: "top", paddingBottom: "0.08em" }}>
            <span
              style={{
                display: "inline-block",
                transform: `translateY(${(1 - p) * 105}%)`,
                opacity: interpolate(p, [0, 0.3], [0, 1], clamp),
                color: lime ? color.accent : undefined,
              }}
            >
              {word}
              {i < words.length - 1 ? " " : ""}
            </span>
          </span>
        );
      })}
    </span>
  );
}

// The left-hand (or, in the vertical cut, top) text of each feature scene.
export function Caption({ step, title, body, delay = 0 }: { step: string; title: string; body?: string; delay?: number }) {
  const vertical = useIsVertical();
  const line = useEnter(delay, { damping: 30 });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: vertical ? 26 : 30, textAlign: vertical ? "center" : "left", alignItems: vertical ? "center" : "flex-start" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, opacity: line }}>
        <span style={{ width: 44 * line, height: 6, background: color.accent }} />
        <span style={{ fontFamily: font.mono, fontSize: 20, letterSpacing: "0.14em", textTransform: "uppercase", color: color.ink2 }}>{step}</span>
      </div>
      <div style={{ ...displayStyle, fontSize: vertical ? 76 : 74, lineHeight: 1.04, color: color.ink }}>
        <StaggerText text={title} delay={delay + 4} />
      </div>
      {body && (
        <Rise delay={delay + 16}>
          <div style={{ fontFamily: font.sans, fontSize: vertical ? 32 : 28, lineHeight: 1.45, color: color.ink2, maxWidth: vertical ? 860 : 560 }}>{body}</div>
        </Rise>
      )}
    </div>
  );
}

// Caption beside the visual (16:9) or above it (9:16). In the vertical cut
// the visual is zoomed (zoom, unlike scale, takes up the room it fills) and
// sits in a fixed-height box, so a card that grows doesn't shift the caption.
export function FeatureLayout({ caption, visual, visualZoomVertical = 1.2, visualHeightVertical = 760 }: { caption: React.ReactNode; visual: React.ReactNode; visualZoomVertical?: number; visualHeightVertical?: number }) {
  const vertical = useIsVertical();
  if (vertical) {
    return (
      <AbsoluteFill style={{ padding: "0 80px", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 80 }}>
        {caption}
        <div style={{ height: visualHeightVertical, display: "flex", alignItems: "flex-start", justifyContent: "center" }}>
          <div style={{ zoom: visualZoomVertical }}>{visual}</div>
        </div>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ padding: "0 130px", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 80 }}>
      <div style={{ width: 640, flexShrink: 0 }}>{caption}</div>
      <div style={{ flex: 1, display: "flex", justifyContent: "center" }}>{visual}</div>
    </AbsoluteFill>
  );
}

// Animated pointer that "taps" at `at` frames.
export function Tap({ at, x, y }: { at: number; x: number; y: number }) {
  const frame = useCurrentFrame();
  const arrive = interpolate(frame, [at - 22, at - 4], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const press = interpolate(frame, [at - 3, at, at + 5], [1, 0.82, 1], clamp);
  const ring = interpolate(frame, [at, at + 16], [0, 1], clamp);
  const leave = interpolate(frame, [at + 18, at + 30], [1, 0], clamp);
  return (
    <div style={{ position: "absolute", left: x, top: y, pointerEvents: "none", opacity: arrive * leave }}>
      <div
        style={{
          position: "absolute",
          left: -28,
          top: -28,
          width: 56,
          height: 56,
          borderRadius: "50%",
          border: `3px solid ${color.accent}`,
          opacity: ring > 0 ? 1 - ring : 0,
          transform: `scale(${0.4 + ring * 1.2})`,
        }}
      />
      <div
        style={{
          width: 30,
          height: 30,
          marginLeft: -15,
          marginTop: -15,
          borderRadius: "50%",
          background: "rgba(236,238,230,0.9)",
          boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
          transform: `translate(${(1 - arrive) * 80}px, ${(1 - arrive) * 120}px) scale(${press})`,
        }}
      />
    </div>
  );
}
