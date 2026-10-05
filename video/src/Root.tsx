import React from "react";
import { Composition } from "remotion";
import { Ad, AD_DURATION } from "./Ad";
import "./fonts";
import { FPS } from "./theme";

// The same ad in two cuts: 16:9 for the site, YouTube and LinkedIn, 9:16 for
// Reels, Shorts and TikTok. Scenes lay themselves out by aspect ratio.
export function RemotionRoot() {
  return (
    <>
      <Composition id="ArbiterAd" component={Ad} durationInFrames={AD_DURATION} fps={FPS} width={1920} height={1080} />
      <Composition id="ArbiterAdVertical" component={Ad} durationInFrames={AD_DURATION} fps={FPS} width={1080} height={1920} />
    </>
  );
}
