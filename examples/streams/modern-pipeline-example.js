/**
 * Modern Pipeline (Promise-based) Example
 *
 * The best way to work with streams in modern Node.js.
 * Import pipeline from 'node:stream/promises' to get Promise version.
 *
 * Benefits:
 * - Works with async/await
 * - Clean error handling with try/catch
 * - No callbacks
 * - Still gets all pipeline() benefits (auto cleanup, error propagation)
 *
 * This is the recommended approach for new code.
 */

import fs from "node:fs";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";

console.log("Starting compression...");

try {
  await pipeline(
    fs.createReadStream("./my-data.txt"),
    zlib.createGzip(),
    fs.createWriteStream("./my-data.txt.gz.new")
  );
  console.log("✓ Pipeline succeeded.");
} catch (err) {
  console.error("Pipeline failed:", err);
}
