import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
await mkdir("dist/web_assets", { recursive: true });
await cp("typescript/ui/assets", "dist/web_assets", { recursive: true });
await cp("typescript/templates", "dist/templates", { recursive: true });
await build({
  entryPoints: ["typescript/ui/app.ts"],
  outfile: "dist/web_assets/app.js",
  target: "es2022",
  sourcemap: true,
});
