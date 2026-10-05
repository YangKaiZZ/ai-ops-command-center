import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// The same self-hosted files the dashboard ships (all SIL OFL).
export const fontsLoaded = Promise.all([
  loadFont({ family: "Archivo", url: staticFile("fonts/archivo-latin-wdth-wght.woff2"), weight: "100 900", stretch: "62% 125%" }),
  loadFont({ family: "Inter", url: staticFile("fonts/inter-latin-wght.woff2"), weight: "100 900" }),
  loadFont({ family: "JetBrains Mono", url: staticFile("fonts/jetbrains-mono-latin-wght.woff2"), weight: "100 800" }),
]);
