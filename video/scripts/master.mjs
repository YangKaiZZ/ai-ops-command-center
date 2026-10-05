// Brings a rendered ad to social-feed loudness (-14 LUFS, peaks under
// -1.5 dBTP) with ffmpeg's two-pass loudnorm, copying the video untouched.
// Uses the ffmpeg that ships with Remotion. Usage: node scripts/master.mjs out/ad.mp4

import { spawnSync } from "node:child_process";
import { renameSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("Usage: node scripts/master.mjs <video.mp4>");
const target = "I=-14:TP=-1.5:LRA=11";

// ffmpeg reports on stderr.
function ffmpeg(args) {
  const run = spawnSync("npx", ["remotion", "ffmpeg", "-hide_banner", "-nostats", ...args], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`ffmpeg failed on ${file}:\n${run.stderr}`);
  return run.stderr;
}

const log = ffmpeg(["-i", file, "-vn", "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"]);
const m = JSON.parse(log.slice(log.lastIndexOf("{"), log.lastIndexOf("}") + 1));

const tmp = file.replace(/\.mp4$/, ".mastering.mp4");
ffmpeg([
  "-y", "-i", file, "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-shortest",
  "-af", `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
  tmp,
]);
renameSync(tmp, file);
console.log(`Mastered ${file}: ${m.input_i} LUFS -> -14 LUFS`);
