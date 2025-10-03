/**
 * stream.finished() Promise Example
 *
 * Promise version of finished() from 'node:stream/promises'.
 * Works with async/await - cleaner than callbacks.
 *
 * Same benefits as callback version:
 * - Wait for any type of completion (end/error/close)
 * - Single await point
 * - Clean error handling with try/catch
 */

import fs from "node:fs";
import { finished } from "node:stream/promises";

const writable = fs.createWriteStream("./temp-file.txt");

writable.write("Some data\n");
writable.write("More data\n");
writable.end("Last bit of data.");

try {
  await finished(writable);
  console.log("✓ Stream finished successfully.");
} catch (err) {
  console.error("✗ Stream failed:", err);
}
