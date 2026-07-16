// Stage the installed zxing-wasm reader binary into public/ so QrScanner serves
// it same-origin instead of the default jsDelivr CDN. Resolving through the
// package's own exported wasm subpath (./reader/zxing_reader.wasm) guarantees
// this is the copy package-lock.json pinned and `npm audit` covers — the
// audited artifact and the executed artifact are then the same file. Runs
// before dev and build.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// zxing-wasm's exports map does NOT expose ./package.json (require.resolve on it
// throws ERR_PACKAGE_PATH_NOT_EXPORTED on Node 20+), but it DOES export
// ./reader/zxing_reader.wasm -> the real binary.
const src = require.resolve("zxing-wasm/reader/zxing_reader.wasm");
mkdirSync("public/wasm", { recursive: true });
copyFileSync(src, "public/wasm/zxing_reader.wasm");
console.log(`[copy-wasm] ${src} -> public/wasm/zxing_reader.wasm`);
