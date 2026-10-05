import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { linearTiming, springTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import { EndCard, Hook, InCharge, TheAlert, TheCall, TheLearning, TheStock } from "./scenes";
import { color } from "./theme";

// Scene lengths in frames at 30 fps. Each transition overlaps the scenes on
// either side, so the total is the sum of the scenes minus the transitions.
const SCENES = { hook: 100, call: 170, alert: 150, stock: 140, learn: 160, charge: 110, end: 160 };
const T = 15;
export const AD_DURATION = Object.values(SCENES).reduce((a, b) => a + b, 0) - 6 * T;

const timing = springTiming({ config: { damping: 200 }, durationInFrames: T });

// Where each transition begins: a scene starts T frames before the one
// before it ends. A whoosh rides each one.
const TRANSITIONS = Object.values(SCENES)
  .slice(0, -1)
  .reduce<number[]>((starts, length, i) => [...starts, (i ? starts[i - 1] : 0) + length - T], []);

export function Ad() {
  return (
    <AbsoluteFill style={{ background: color.page }}>
      {/* Made by scripts/make-sounds.mjs, its beat grid anchored to this cut. */}
      <Audio src={staticFile("audio/music.wav")} volume={0.8} />
      {TRANSITIONS.map((at) => (
        <Sequence key={at} from={at - 4} layout="none" name="sfx: whoosh">
          <Audio src={staticFile("audio/whoosh.wav")} volume={0.3} />
        </Sequence>
      ))}
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={SCENES.hook}>
          <Hook />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence durationInFrames={SCENES.call}>
          <TheCall />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={slide({ direction: "from-right" })} timing={timing} />
        <TransitionSeries.Sequence durationInFrames={SCENES.alert}>
          <TheAlert />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={slide({ direction: "from-bottom" })} timing={timing} />
        <TransitionSeries.Sequence durationInFrames={SCENES.stock}>
          <TheStock />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={slide({ direction: "from-right" })} timing={timing} />
        <TransitionSeries.Sequence durationInFrames={SCENES.learn}>
          <TheLearning />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={wipe({ direction: "from-left" })} timing={timing} />
        <TransitionSeries.Sequence durationInFrames={SCENES.charge}>
          <InCharge />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence durationInFrames={SCENES.end}>
          <EndCard />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
}
