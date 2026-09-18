import { mkdir, rm } from "node:fs/promises";
import { compile } from "sass";

const dist = "dist";

await rm(dist, { recursive: true, force: true });
await mkdir(`${dist}/assets`, { recursive: true });
await mkdir(`${dist}/scripts`, { recursive: true });
await mkdir(`${dist}/styles`, { recursive: true });

const html = await Bun.file("src/index.html").text();
await Bun.write(
  `${dist}/index.html`,
  html
    .replace("styles/styles.scss", "styles/styles.css")
    .replace("scripts/script.ts", "scripts/script.js"),
);
await Bun.write(
  `${dist}/styles/styles.css`,
  compile("src/styles/styles.scss", { style: "compressed" }).css,
);
await Bun.write(`${dist}/assets/logo.svg`, Bun.file("src/assets/logo.svg"));

const result = await Bun.build({
  entrypoints: ["src/scripts/script.ts"],
  outdir: `${dist}/scripts`,
  target: "browser",
  minify: true,
});

if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}
