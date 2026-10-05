import React from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop, Badge, Caption, cardStyle, clamp, FeatureLayout, hexA, Logo, Rise, SampleTag, Sfx, StaggerText, Tap, useEnter, useIsVertical } from "./components";
import {
  ArrowRightIcon,
  ChatCircleDotsIcon,
  CheckIcon,
  CubeIcon,
  EnvelopeSimpleIcon,
  NotePencilIcon,
  PackageIcon,
  PaperPlaneTiltIcon,
  PauseIcon,
  ShieldCheckIcon,
  ShieldWarningIcon,
  SlackLogoIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TruckIcon,
  UserCircleCheckIcon,
  WarningIcon,
  type Icon,
} from "./icons";
import { color, displayStyle, FPS, font } from "./theme";

// A spring from 0 to 1 starting at `delay`, for use inside loops.
function enterAt(frame: number, delay: number, config: { damping?: number; stiffness?: number } = {}) {
  return spring({ frame: frame - delay, fps: FPS, config: { damping: 200, stiffness: 120, ...config } });
}

// ---------------------------------------------------------------------------
// 1. Hook: orders pile up, and each one is a call to make.

const PINGS = [
  { n: "#1041", x: 0.13, y: 0.2, d: 0 },
  { n: "#1042", x: 0.8, y: 0.17, d: 6 },
  { n: "#1043", x: 0.86, y: 0.74, d: 12 },
  { n: "#1044", x: 0.11, y: 0.76, d: 9 },
  { n: "#1045", x: 0.32, y: 0.9, d: 16 },
  { n: "#1046", x: 0.64, y: 0.91, d: 20 },
  { n: "#1047", x: 0.47, y: 0.08, d: 3 },
];

export function Hook() {
  const frame = useCurrentFrame();
  const vertical = useIsVertical();
  const { width, height } = useVideoConfig();
  const chips = [
    { label: "Fulfill", tone: "good" as const, icon: CheckIcon },
    { label: "Hold", tone: "warning" as const, icon: PauseIcon },
    { label: "Restock", tone: "serious" as const, icon: WarningIcon },
  ];
  return (
    <AbsoluteFill>
      <Backdrop glowX={0.5} glowY={0.5} />
      {PINGS.map((p) => (
        <Sfx key={p.n} at={p.d} name="blip" volume={0.12} />
      ))}
      <Sfx at={40} name="pop1" volume={0.45} />
      <Sfx at={47} name="pop2" volume={0.45} />
      <Sfx at={54} name="pop3" volume={0.45} />
      {PINGS.map((p, i) => {
        const e = enterAt(frame, p.d, { damping: 14, stiffness: 160 });
        const float = Math.sin((frame + i * 20) / 22) * 8;
        return (
          <div
            key={p.n}
            style={{
              position: "absolute",
              left: p.x * width - 110,
              top: (vertical ? p.y * 0.9 + 0.05 : p.y) * height - 30 + float,
              opacity: e * 0.55,
              transform: `scale(${0.6 + e * 0.4})`,
              ...cardStyle,
              borderRadius: 12,
              padding: "12px 18px",
              display: "flex",
              alignItems: "center",
              gap: 12,
              filter: "blur(0.6px)",
            }}
          >
            <PackageIcon size={22} color={color.ink2} weight="bold" />
            <span style={{ fontFamily: font.sans, fontSize: 18, color: color.ink2 }}>New order</span>
            <span style={{ fontFamily: font.mono, fontSize: 18, fontWeight: 600, color: color.inkSoft }}>{p.n}</span>
          </div>
        );
      })}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 54, padding: 80 }}>
        <div style={{ ...displayStyle, fontSize: vertical ? 118 : 136, lineHeight: 1.02, textAlign: "center", color: color.ink }}>
          <StaggerText text="Every order" delay={4} every={4} />
          <br />
          <StaggerText text="is a *call.*" delay={14} every={4} />
        </div>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", justifyContent: "center" }}>
          {chips.map((c, i) => {
            const p = enterAt(frame, 40 + i * 7, { damping: 12, stiffness: 180 });
            return (
              <div key={c.label} style={{ opacity: p, transform: `translateY(${(1 - p) * 30}px) scale(${0.8 + p * 0.2})` }}>
                <Badge label={c.label} tone={c.tone} icon={c.icon} scale={2} />
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------
// 2. The call: code checks stock and fraud, and a high risk is a hold the
//    model can't overrule.

function CheckRow({ delay, icon: Glyph, label, result, tone }: { delay: number; icon: Icon; label: string; result: string; tone: "good" | "warning" | "critical" }) {
  const frame = useCurrentFrame();
  const appear = enterAt(frame, delay);
  const scanning = frame >= delay && frame < delay + 14;
  const done = enterAt(frame, delay + 14, { damping: 14, stiffness: 200 });
  const tones = { good: color.good, warning: color.warning, critical: color.critical };
  return (
    <div
      style={{
        opacity: appear,
        transform: `translateX(${(1 - appear) * 24}px)`,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "14px 18px",
        borderRadius: 12,
        background: color.well,
        border: `1.5px solid ${done > 0.5 ? hexA(tones[tone], 0.28) : color.hairline}`,
      }}
    >
      <Glyph size={24} weight="bold" color={done > 0.5 ? tones[tone] : color.ink2} />
      <span style={{ fontFamily: font.sans, fontSize: 20, color: color.inkSoft, flex: 1 }}>{label}</span>
      {frame < delay + 14 ? (
        <span style={{ fontFamily: font.mono, fontSize: 16, color: color.ink2, opacity: scanning ? 1 : 0 }}>checking{".".repeat(1 + (Math.floor(frame / 4) % 3))}</span>
      ) : (
        <span style={{ opacity: done, transform: `scale(${0.7 + done * 0.3})` }}>
          <Badge label={result} tone={tone} scale={1.1} />
        </span>
      )}
    </div>
  );
}

function OrderCallCard() {
  const frame = useCurrentFrame();
  const enter = useEnter(6, { damping: 22, stiffness: 110 });
  const verdict = enterAt(frame, 92, { damping: 9, stiffness: 220 });
  const reason = useEnter(102);
  return (
    <div style={{ perspective: 1400 }}>
      <div
        style={{
          ...cardStyle,
          width: 760,
          padding: "30px 32px",
          display: "grid",
          gap: 20,
          opacity: enter,
          transform: `translateY(${(1 - enter) * 60}px) rotateX(${(1 - enter) * 14}deg)`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontFamily: font.mono, fontSize: 30, fontWeight: 700, color: color.ink }}>#1047</span>
          <span style={{ fontFamily: font.sans, fontSize: 19, color: color.ink2 }}>New order · just now</span>
          <span style={{ marginLeft: "auto" }}>
            <SampleTag />
          </span>
        </div>
        <div style={{ display: "grid", gap: 8, fontFamily: font.sans, fontSize: 20, color: color.inkSoft }}>
          {[
            ["Wool Throw", "1", "$89.00"],
            ["Ceramic Mug", "2", "$36.00"],
          ].map(([name, qty, price]) => (
            <div key={name} style={{ display: "flex", justifyContent: "space-between", paddingBottom: 8, borderBottom: `1px solid ${color.hairline}` }}>
              <span>
                {name} <span style={{ color: color.ink2 }}>× {qty}</span>
              </span>
              <span style={{ fontFamily: font.mono, color: color.ink }}>{price}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <CheckRow delay={30} icon={CubeIcon} label="Live stock in Shopify" result="Every item can ship" tone="good" />
          <CheckRow delay={50} icon={ShieldWarningIcon} label="Shopify fraud analysis" result="High risk" tone="critical" />
          <CheckRow delay={70} icon={TruckIcon} label="Billing and shipping addresses" result="Don't match" tone="warning" />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 22, minHeight: 64, paddingTop: 4 }}>
          <div style={{ opacity: verdict, transform: `scale(${2.2 - verdict * 1.2}) rotate(${(1 - verdict) * -8}deg)`, transformOrigin: "left center" }}>
            <Badge label="Hold" tone="warning" icon={PauseIcon} scale={1.8} />
          </div>
          <div style={{ opacity: reason, fontFamily: font.sans, fontSize: 20, lineHeight: 1.35, color: color.inkSoft }}>
            A high fraud risk is a hold
            <br />
            the model can't overrule.
          </div>
        </div>
      </div>
    </div>
  );
}

export function TheCall() {
  return (
    <AbsoluteFill>
      <Backdrop glowX={0.72} glowY={0.45} />
      {/* The card's rows appear, are checked, and get their result. */}
      {[30, 50, 70].map((d) => (
        <Sfx key={d} at={d} name="tick" volume={0.3} />
      ))}
      <Sfx at={44} name="good" volume={0.4} />
      <Sfx at={64} name="bad" volume={0.45} />
      <Sfx at={84} name="warn" volume={0.35} />
      <Sfx at={92} name="stamp" volume={0.75} />
      <FeatureLayout
        caption={<Caption step="01 · The call" title="The agent decides. Code checks it." body="Stock comes live from Shopify. Fraud risk from Shopify's own analysis." />}
        visual={<OrderCallCard />}
      />
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------
// 3. The alert: it reaches the seller where they are, with the action one
//    tap away.

function ChannelPill({ icon: Glyph, label, delay }: { icon: Icon; label: string; delay: number }) {
  const p = useEnter(delay, { damping: 14, stiffness: 180 });
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${(1 - p) * 20}px)`,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 18px",
        borderRadius: 999,
        background: color.field,
        border: `1.5px solid ${color.border}`,
        fontFamily: font.sans,
        fontSize: 20,
        fontWeight: 550,
        color: color.inkSoft,
      }}
    >
      <Glyph size={22} weight="bold" color={color.accent} />
      {label}
    </div>
  );
}

function Phone() {
  const frame = useCurrentFrame();
  const enter = useEnter(4, { damping: 24, stiffness: 100 });
  const msg = enterAt(frame, 26, { damping: 15, stiffness: 160 });
  const TAP = 84;
  const tapped = frame >= TAP;
  const confirm = enterAt(frame, TAP + 2, { damping: 14, stiffness: 200 });
  const later = enterAt(frame, TAP + 20, { damping: 15, stiffness: 160 });
  return (
    <div style={{ position: "relative", opacity: enter, transform: `translateY(${(1 - enter) * 80}px)` }}>
      <div
        style={{
          width: 470,
          height: 760,
          borderRadius: 64,
          background: "#050604",
          border: `2px solid ${color.border}`,
          padding: 16,
          boxShadow: "0 50px 120px rgba(0,0,0,0.6), inset 0 0 0 6px #0d0f0b",
        }}
      >
        <div style={{ width: "100%", height: "100%", borderRadius: 50, background: color.sidebar, overflow: "hidden", position: "relative", padding: "64px 22px 22px" }}>
          <div style={{ position: "absolute", top: 18, left: "50%", marginLeft: -60, width: 120, height: 32, borderRadius: 20, background: "#000" }} />
          <div style={{ fontFamily: font.sans, fontSize: 16, color: color.ink2, textAlign: "center", marginBottom: 22 }}>Today · 9:41</div>
          <div
            style={{
              opacity: msg,
              transform: `translateY(${(1 - msg) * -40}px) scale(${0.94 + msg * 0.06})`,
              background: color.surface,
              border: `1.5px solid ${color.border}`,
              borderRadius: 22,
              padding: 20,
              display: "grid",
              gap: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, background: color.accent, display: "grid", placeItems: "center" }}>
                <svg viewBox="0 0 64 64" width={24} height={24}>
                  <path d="M10.5 51 L32 13.8 L53.5 51" fill="none" stroke={color.onAccent} strokeWidth={9.5} strokeLinejoin="miter" />
                  <path d="M25.52 39.5H38.48L42.82 47H21.18Z" fill={color.onAccent} />
                </svg>
              </div>
              <span style={{ fontFamily: font.sans, fontWeight: 650, fontSize: 18, color: color.ink }}>Arbiter Ops</span>
              <span style={{ marginLeft: "auto", fontFamily: font.sans, fontSize: 15, color: color.ink2 }}>now</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Badge label="Hold" tone="warning" icon={PauseIcon} />
              <span style={{ fontFamily: font.mono, fontSize: 19, fontWeight: 700, color: color.ink }}>#1047</span>
              <span style={{ marginLeft: "auto" }}>
                <SampleTag />
              </span>
            </div>
            <div style={{ fontFamily: font.sans, fontSize: 18, lineHeight: 1.45, color: color.inkSoft }}>
              Shopify rates this order high risk, and the billing and shipping addresses don't match.
            </div>
            <div
              style={{
                borderRadius: 12,
                padding: "13px 16px",
                textAlign: "center",
                fontFamily: font.sans,
                fontWeight: 650,
                fontSize: 18,
                background: tapped ? hexA(color.good, 0.1) : color.accent,
                color: tapped ? color.good : color.onAccent,
                border: tapped ? `1.5px solid ${hexA(color.good, 0.35)}` : "1.5px solid transparent",
                transform: `scale(${tapped ? 0.97 + confirm * 0.03 : 1})`,
              }}
            >
              {tapped ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, opacity: confirm }}>
                  <CheckIcon size={20} weight="bold" /> On hold in Shopify
                </span>
              ) : (
                "Put on hold in Shopify"
              )}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              {(
                [
                  [ThumbsUpIcon, "Right call"],
                  [ThumbsDownIcon, "Wrong call"],
                ] as const
              ).map(([Glyph, label]) => (
                <div
                  key={label}
                  style={{
                    flex: 1,
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    gap: 8,
                    padding: "11px 0",
                    borderRadius: 12,
                    background: color.field,
                    border: `1.5px solid ${color.border}`,
                    fontFamily: font.sans,
                    fontSize: 16,
                    fontWeight: 550,
                    color: color.inkSoft,
                  }}
                >
                  <Glyph size={18} weight="bold" /> {label}
                </div>
              ))}
            </div>
          </div>
          <div
            style={{
              marginTop: 14,
              opacity: later,
              transform: `translateY(${(1 - later) * -30}px)`,
              background: color.surface,
              border: `1.5px solid ${color.border}`,
              borderRadius: 22,
              padding: 20,
              display: "grid",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Badge label="Restock" tone="serious" icon={WarningIcon} />
              <span style={{ fontFamily: font.sans, fontWeight: 600, fontSize: 18, color: color.ink }}>Linen Scarf</span>
              <span style={{ marginLeft: "auto", fontFamily: font.sans, fontSize: 15, color: color.ink2 }}>now</span>
            </div>
            <div style={{ fontFamily: font.sans, fontSize: 17, lineHeight: 1.45, color: color.inkSoft }}>2 left. Runs out in about 3 days. Reorder 24.</div>
          </div>
        </div>
      </div>
      <Tap at={TAP} x={235} y={354} />
    </div>
  );
}

export function TheAlert() {
  const vertical = useIsVertical();
  return (
    <AbsoluteFill>
      <Backdrop glowX={0.7} glowY={0.5} />
      <Sfx at={26} name="notify" volume={0.5} />
      <Sfx at={84} name="click" volume={0.55} />
      <Sfx at={87} name="success" volume={0.4} />
      <Sfx at={104} name="notify" volume={0.25} />
      <FeatureLayout
        caption={
          <div style={{ display: "grid", gap: 34, justifyItems: vertical ? "center" : "start" }}>
            <Caption step="02 · The alert" title="It finds you where you already are." />
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: vertical ? "center" : "flex-start" }}>
              <ChannelPill icon={SlackLogoIcon} label="Slack" delay={26} />
              <ChannelPill icon={EnvelopeSimpleIcon} label="Email" delay={31} />
              <ChannelPill icon={PaperPlaneTiltIcon} label="Telegram" delay={36} />
            </div>
            <Rise delay={44}>
              <div style={{ fontFamily: font.sans, fontSize: vertical ? 32 : 28, lineHeight: 1.45, color: color.ink2, maxWidth: vertical ? 860 : 560, textAlign: vertical ? "center" : "left" }}>
                Hold or ship right from the alert. Only what Shopify allows right now.
              </div>
            </Rise>
          </div>
        }
        visual={<Phone />}
        visualZoomVertical={1.3}
        visualHeightVertical={1020}
      />
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------
// 4. Stock: restock forecasts worked out from the store's own orders.

const STOCK = [
  { name: "Linen Scarf", left: 2, days: 3, note: "Runs out in about 3 days · reorder 24", tone: "critical" as const, badge: "Restock" },
  { name: "Recycled Notebook", left: 9, days: 8, note: "Runs out in about 8 days · reorder 30", tone: "serious" as const, badge: "Restock" },
  { name: "Ceramic Mug", left: 14, days: 21, note: "About 21 days left", tone: "good" as const, badge: "OK" },
];

function StockCard() {
  const frame = useCurrentFrame();
  const enter = useEnter(6, { damping: 22, stiffness: 110 });
  const tones = { critical: color.critical, serious: color.serious, good: color.good };
  return (
    <div style={{ ...cardStyle, width: 760, padding: "28px 32px", display: "grid", gap: 24, opacity: enter, transform: `translateY(${(1 - enter) * 60}px)` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span style={{ ...displayStyle, fontSize: 28, color: color.ink }}>Stock</span>
        <span style={{ fontFamily: font.sans, fontSize: 18, color: color.ink2 }}>Days left at the current pace</span>
        <span style={{ marginLeft: "auto" }}>
          <SampleTag />
        </span>
      </div>
      {STOCK.map((s, i) => {
        const d = 18 + i * 12;
        const row = enterAt(frame, d);
        const fill = interpolate(frame, [d + 6, d + 40], [0, s.days / 30], { ...clamp, easing: Easing.out(Easing.cubic) });
        return (
          <div key={s.name} style={{ display: "grid", gap: 10, opacity: row, transform: `translateY(${(1 - row) * 16}px)` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontFamily: font.sans, fontSize: 22, fontWeight: 600, color: color.ink }}>{s.name}</span>
              <span style={{ fontFamily: font.mono, fontSize: 17, color: color.ink2 }}>{s.left} left</span>
              <span style={{ marginLeft: "auto" }}>
                <Badge label={s.badge} tone={s.tone} icon={s.tone === "good" ? CheckIcon : WarningIcon} scale={1.1} />
              </span>
            </div>
            <div style={{ height: 12, borderRadius: 6, background: color.well, border: `1px solid ${color.hairline}`, overflow: "hidden" }}>
              <div style={{ width: `${fill * 100}%`, height: "100%", background: tones[s.tone], borderRadius: 6 }} />
            </div>
            <span style={{ fontFamily: font.sans, fontSize: 18, color: color.inkSoft }}>{s.note}</span>
          </div>
        );
      })}
      <Rise delay={64} distance={10}>
        <div style={{ fontFamily: font.mono, fontSize: 15, color: color.ink2, paddingTop: 14, borderTop: `1px solid ${color.hairline}` }}>
          Based on 30 days of this store's orders
        </div>
      </Rise>
    </div>
  );
}

export function TheStock() {
  return (
    <AbsoluteFill>
      <Backdrop glowX={0.7} glowY={0.4} />
      {[18, 30, 42].map((d) => (
        <Sfx key={d} at={d} name="tick" volume={0.3} />
      ))}
      <Sfx at={24} name="bad" volume={0.25} />
      <FeatureLayout
        caption={<Caption step="03 · Stock" title="Knows what runs out before it does." body="Forecasts from your own orders, always with how much history they're based on." />}
        visual={<StockCard />}
      />
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------
// 5. It learns: a "Wrong call" note changes the next call. The note is the
//    one the demo store ships with.

const NOTE = "Bank transfers always show as pending at first and clear within a day: ship them.";

function LearnCards() {
  const frame = useCurrentFrame();
  const first = useEnter(4, { damping: 22 });
  const TAP = 30;
  const pressed = frame >= TAP;
  const typed = Math.floor(interpolate(frame, [38, 82], [0, NOTE.length], clamp));
  const second = enterAt(frame, 94, { damping: 16, stiffness: 140 });
  const glow = interpolate(frame, [110, 124, 150], [0, 1, 0.4], clamp);
  return (
    <div style={{ position: "relative", width: 760, display: "grid", gap: 22 }}>
      <div
        style={{
          ...cardStyle,
          padding: "24px 28px",
          display: "grid",
          gap: 14,
          opacity: first * interpolate(second, [0, 1], [1, 0.55]),
          transform: `translateY(${(1 - first) * 40}px) scale(${1 - second * 0.03})`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Badge label="Hold" tone="warning" icon={PauseIcon} scale={1.1} />
          <span style={{ fontFamily: font.mono, fontSize: 22, fontWeight: 700, color: color.ink }}>#1032</span>
          <span style={{ fontFamily: font.sans, fontSize: 17, color: color.ink2 }}>New order · 3 days ago</span>
          <span style={{ marginLeft: "auto" }}>
            <SampleTag />
          </span>
        </div>
        <div style={{ fontFamily: font.sans, fontSize: 19, color: color.inkSoft }}>Payment status is pending (bank transfer), so it isn't paid yet.</div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", borderRadius: 10, background: color.field, border: `1.5px solid ${color.border}`, fontFamily: font.sans, fontSize: 16, color: color.inkSoft }}>
            <ThumbsUpIcon size={18} weight="bold" /> Right call
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "9px 16px",
              borderRadius: 10,
              fontFamily: font.sans,
              fontSize: 16,
              fontWeight: pressed ? 650 : 400,
              background: pressed ? hexA(color.critical, 0.1) : color.field,
              border: `1.5px solid ${pressed ? hexA(color.critical, 0.4) : color.border}`,
              color: pressed ? color.critical : color.inkSoft,
            }}
          >
            <ThumbsDownIcon size={18} weight={pressed ? "fill" : "bold"} /> Wrong call
          </div>
        </div>
        {frame >= 36 && (
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "14px 16px", borderRadius: 12, background: color.well, border: `1.5px solid ${color.hairline}` }}>
            <NotePencilIcon size={22} weight="bold" color={color.accent} style={{ marginTop: 2, flexShrink: 0 }} />
            <span style={{ fontFamily: font.sans, fontSize: 18, lineHeight: 1.45, color: color.ink }}>
              <b style={{ fontWeight: 650 }}>Your note: </b>
              {NOTE.slice(0, typed)}
              <span style={{ opacity: typed < NOTE.length && Math.floor(frame / 8) % 2 === 0 ? 1 : 0, color: color.accent }}>|</span>
            </span>
          </div>
        )}
      </div>
      <div
        style={{
          ...cardStyle,
          padding: "24px 28px",
          display: "grid",
          gap: 14,
          opacity: second,
          transform: `translateY(${(1 - second) * 70}px)`,
          border: `1.5px solid ${hexA(color.accent, 0.25 + glow * 0.45)}`,
          boxShadow: `${cardStyle.boxShadow}, 0 0 ${60 * glow}px ${hexA(color.accent, 0.18 * glow)}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Badge label="Fulfill" tone="good" icon={CheckIcon} scale={1.1} />
          <span style={{ fontFamily: font.mono, fontSize: 22, fontWeight: 700, color: color.ink }}>#1063</span>
          <span style={{ fontFamily: font.sans, fontSize: 17, color: color.ink2 }}>New order · just now</span>
        </div>
        <div style={{ fontFamily: font.sans, fontSize: 19, color: color.inkSoft }}>Payment is pending by bank transfer, and every item is in stock.</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: font.sans, fontSize: 18, fontWeight: 600, color: color.accent }}>
          <UserCircleCheckIcon size={22} weight="bold" /> Your note on #1032 changed this call.
        </div>
      </div>
      <Tap at={TAP} x={232} y={126} />
    </div>
  );
}

export function TheLearning() {
  return (
    <AbsoluteFill>
      <Backdrop glowX={0.68} glowY={0.55} />
      <Sfx at={30} name="click" volume={0.55} />
      <Sfx at={38} name="typing" volume={0.35} />
      <Sfx at={92} name="swish" volume={0.35} />
      <Sfx at={110} name="success" volume={0.45} />
      <FeatureLayout
        caption={<Caption step="04 · It learns" title="Rate a call. It learns your store." body="It reads your notes before similar calls, and says when one changed its mind." />}
        visual={<LearnCards />}
      />
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------
// 6. In charge: the agent recommends, the seller decides.

export function InCharge() {
  const frame = useCurrentFrame();
  const vertical = useIsVertical();
  const points = [
    { icon: ShieldCheckIcon, text: "It never ships on its own" },
    { icon: PauseIcon, text: "Auto-hold stays off until you switch it on" },
    { icon: ChatCircleDotsIcon, text: "Every call comes with its reason" },
  ];
  const sweep = interpolate(frame, [24, 44], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  return (
    <AbsoluteFill>
      <Backdrop glowX={0.5} glowY={0.45} />
      <Sfx at={24} name="swish" volume={0.45} />
      <Sfx at={46} name="pop1" volume={0.35} />
      <Sfx at={53} name="pop2" volume={0.35} />
      <Sfx at={60} name="pop3" volume={0.35} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 70, padding: 80 }}>
        <div style={{ ...displayStyle, fontSize: vertical ? 100 : 120, lineHeight: 1.08, textAlign: "center", color: color.ink }}>
          <StaggerText text="The agent recommends." delay={2} every={4} />
          <br />
          <span style={{ position: "relative", display: "inline-block", marginTop: 14 }}>
            <span style={{ position: "absolute", left: -20, right: -20, top: "6%", bottom: "-2%", background: color.accent, transformOrigin: "left", transform: `scaleX(${sweep})` }} />
            <span style={{ position: "relative", color: sweep > 0.55 ? color.onAccent : color.ink }}>
              <StaggerText text="You decide." delay={14} every={4} />
            </span>
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: vertical ? "column" : "row", gap: 20 }}>
          {points.map((p, i) => {
            const e = enterAt(frame, 46 + i * 7);
            const Glyph = p.icon;
            return (
              <div
                key={p.text}
                style={{
                  opacity: e,
                  transform: `translateY(${(1 - e) * 24}px)`,
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "18px 26px",
                  borderRadius: 14,
                  background: color.surface,
                  border: `1.5px solid ${color.border}`,
                  fontFamily: font.sans,
                  fontSize: vertical ? 30 : 24,
                  fontWeight: 550,
                  color: color.inkSoft,
                }}
              >
                <Glyph size={vertical ? 32 : 26} weight="bold" color={color.accent} />
                {p.text}
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------
// 7. End card: the Caret draws itself, then the wordmark and the call to action.

export function EndCard() {
  const frame = useCurrentFrame();
  const vertical = useIsVertical();
  const draw = interpolate(frame, [4, 30], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const bar = enterAt(frame, 28, { damping: 10, stiffness: 200 });
  const word = useEnter(38, { damping: 24 });
  const pulse = frame > 100 ? 1 + Math.max(0, Math.sin((frame - 100) / 8)) * 0.025 : 1;
  const surfaces = ["Dashboard", "Alerts", "Chat", "Claude Desktop"];
  return (
    <AbsoluteFill>
      <Backdrop glowX={0.5} glowY={0.42} />
      <Sfx at={4} name="shimmer" volume={0.4} />
      <Sfx at={28} name="lock" volume={0.55} />
      <Sfx at={72} name="pop2" volume={0.35} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 44, padding: 80 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 34, flexDirection: vertical ? "column" : "row" }}>
          <Logo size={vertical ? 190 : 170} draw={draw} bar={bar} />
          <div
            style={{
              ...displayStyle,
              fontSize: vertical ? 132 : 150,
              lineHeight: 1,
              color: color.ink,
              opacity: word,
              transform: vertical ? `translateY(${(1 - word) * 20}px)` : `translateX(${(1 - word) * -30}px)`,
            }}
          >
            Arbiter <span style={{ color: color.ink2 }}>Ops</span>
          </div>
        </div>
        <Rise delay={52}>
          <div style={{ fontFamily: font.sans, fontSize: vertical ? 40 : 38, color: color.inkSoft, textAlign: "center" }}>The AI operations assistant for Shopify stores.</div>
        </Rise>
        <Rise delay={60}>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", fontFamily: font.mono, fontSize: vertical ? 24 : 21, color: color.ink2, letterSpacing: "0.04em" }}>
            {surfaces.map((s, i) => (
              <React.Fragment key={s}>
                {i > 0 && <span style={{ color: color.border }}>/</span>}
                <span>{s}</span>
              </React.Fragment>
            ))}
          </div>
        </Rise>
        <Rise delay={72}>
          <div style={{ display: "flex", alignItems: "center", gap: 28, marginTop: 16, flexDirection: vertical ? "column" : "row" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "22px 40px",
                borderRadius: 16,
                background: color.accent,
                color: color.onAccent,
                fontFamily: font.sans,
                fontWeight: 700,
                fontSize: vertical ? 40 : 34,
                transform: `scale(${pulse})`,
                boxShadow: `0 0 60px ${hexA(color.accent, 0.25)}`,
              }}
            >
              Try the demo <ArrowRightIcon size={vertical ? 36 : 30} weight="bold" />
            </div>
            <span style={{ fontFamily: font.mono, fontSize: vertical ? 34 : 30, color: color.ink }}>aiops-cocenter.site</span>
          </div>
        </Rise>
        <Rise delay={84}>
          <div style={{ fontFamily: font.sans, fontSize: vertical ? 24 : 21, color: color.ink2 }}>A sample store of your own. No account needed.</div>
        </Rise>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
