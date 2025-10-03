/**
 * Pipeline (Callback) Example
 *
 * stream.pipeline() is better than .pipe() for production code.
 *
 * Why pipeline() > pipe():
 * - Automatic error handling across entire chain
 * - Proper cleanup if ANY stream errors
 * - Single callback when done (success or error)
 * - Prevents memory leaks from dangling streams
 *
 * .pipe() doesn't auto-destroy streams on error, which can leak resources.
 * Always use pipeline() in production.
 */

import fs from "node:fs";
import zlib from "node:zlib";
import { pipeline } from "node:stream";

const source = fs.createReadStream("./my-data.txt");
const destination = fs.createWriteStream("./my-data.txt.gz");
const gzip = zlib.createGzip();

console.log("Starting compression with pipeline()...");

pipeline(
  source,
  gzip,
  destination,
  (err) => {
    if (err) {
      console.error("Pipeline failed:", err);
      // All streams have been properly destroyed
    } else {
      console.log("✓ Pipeline succeeded.");
    }
  }
);
