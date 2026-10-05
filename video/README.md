# Arbiter Ops ad

A 30-second motion graphics ad for Arbiter Ops, made with
[Remotion](https://www.remotion.dev). It comes in two cuts from the same
scenes: 16:9 (`ArbiterAd`, 1920×1080) for the site, YouTube and LinkedIn, and
9:16 (`ArbiterAdVertical`, 1080×1920) for Reels, Shorts and TikTok. The
scenes lay themselves out by aspect ratio.

It uses the dashboard's tokens, fonts (copied from `dashboard/src/app/fonts`)
and Phosphor icons. Orders, items and the note come from the demo store
(`backend/src/services/demo.js`) and are labelled "Sample store", per the brand
rules in `PRODUCT.md`: no invented customers, numbers or claims.

| Time | Scene | What it shows |
| --- | --- | --- |
| 0:00 | Hook | "Every order is a call." Fulfill / Hold / Restock |
| 0:03 | 01 · The call | Code checks stock and fraud; a high risk is a hold the model can't overrule |
| 0:08 | 02 · The alert | Slack, email, Telegram; hold from the alert |
| 0:13 | 03 · Stock | Restock forecasts with the history they're based on |
| 0:17 | 04 · It learns | A Wrong call note changes the next call |
| 0:22 | In charge | "The agent recommends. You decide." |
| 0:25 | End card | The Caret draws itself; Try the demo, aiops-cocenter.site |

## Sound

Everything you hear is synthesized by `scripts/make-sounds.mjs` from
oscillators and noise (no samples, so no licences to worry about):

- **Music bed**, about 121 BPM in A minor (Am, F, C, G). Its beat grid is
  anchored to the cut: the drums come in with scene 01 (frame 85) and the drop
  lands on the end card (frame 740). The beat drops out for a breakdown and
  riser under "You decide." If you change scene lengths in `src/Ad.tsx`,
  update `CALL_START` and `END_START` in the script.
- **Sound effects** for the on-screen moments: badge pops, row ticks, a chime
  for "Every item can ship" and a low tone for "High risk", a stamp for the Hold,
  a notification, the tap and its success sound, typing, a whoosh on each
  transition, and a shimmer and lock for the logo. Each one is placed in the
  scene next to the animation it belongs to (`<Sfx at={...} />`), so it
  moves when the animation does.

`npm run sounds` writes the WAVs to `public/audio` (not committed; the
studio and render scripts make them first). After each render,
`scripts/master.mjs` normalizes the audio to -14 LUFS with peaks under
-1.5 dBTP (two-pass loudnorm, using the ffmpeg that ships with Remotion),
which is the usual loudness for YouTube, Instagram and TikTok.

## Commands

```bash
npm install
npm run studio            # preview and scrub in the browser
npm run sounds            # regenerate the music and effects
npm run render            # out/arbiter-ops-ad.mp4 (makes sounds, renders, masters)
npm run render:vertical   # out/arbiter-ops-ad-vertical.mp4
npm run still             # out/poster.png, a frame from the end card
npm run typecheck
```

Rendering needs Chrome; Remotion downloads its own headless shell, or pass
`--browser-executable=/path/to/chrome`.

## Files

- `src/theme.ts`: colors and type, mirrored from `dashboard/src/app/globals.css`
- `src/components.tsx`: backdrop, the Caret mark, status badges, captions, layout, tap pointer
- `src/scenes.tsx`: the seven scenes
- `src/Ad.tsx`: scene lengths and transitions
- `src/Root.tsx`: the two compositions
- `scripts/make-sounds.mjs`: the music bed and sound effects
- `scripts/master.mjs`: loudness mastering of a rendered MP4
