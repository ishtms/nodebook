/**
 * Pipeline with AbortSignal Example
 *
 * Shows how to cancel/timeout stream operations.
 * Critical for production apps that need to handle:
 * - User cancellations
 * - Timeouts
 * - Client disconnections
 *
 * Use AbortController to control cancellation.
 * Pass signal to pipeline options.
 *
 * Note: This example aborts after 5 seconds.
 * For real file, use a larger file or shorter timeout to see effect.
 */

import fs from "node:fs";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";

const ac = new AbortController();

// Cancel after 5 seconds
setTimeout(() => {
  console.log("Aborting pipeline (timeout)...");
  ac.abort();
}, 5000);

try {
  await pipeline(
    fs.createReadStream("./my-data.txt"),
    zlib.createGzip(),
    fs.createWriteStream("./my-data.txt.gz.abort"),
    { signal: ac.signal } // Pass abort signal
  );
  console.log("✓ Pipeline succeeded.");
} catch (err) {
  if (err.name === "AbortError") {
    console.error("✗ Pipeline aborted (timeout)");
  } else {
    console.error("Pipeline failed:", err);
  }
}

// Shorter syntax using AbortSignal.timeout()
console.log("\n--- Using AbortSignal.timeout() ---");
try {
  await pipeline(
    fs.createReadStream("./my-data.txt"),
    zlib.createGzip(),
    fs.createWriteStream("./my-data.txt.gz.timeout"),
    { signal: AbortSignal.timeout(5000) } // 5 second timeout
  );
  console.log("✓ Pipeline succeeded.");
} catch (err) {
  if (err.name === "AbortError") {
    console.error("✗ Pipeline timed out");
  } else {
    console.error("Pipeline failed:", err);
  }
}
