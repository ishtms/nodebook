/**
 * Readable Stream - Async Iteration Example
 *
 * The cleanest way to consume readable streams in modern Node.js.
 * Every readable stream is an async iterable, so you can use for await...of
 *
 * Why this is better:
 * - Clean, readable code
 * - Automatic error handling with try/catch
 * - Respects backpressure automatically
 * - No manual event listeners needed
 *
 * This is the recommended approach for most use cases.
 */

import fs from "node:fs";

const readableStream = fs.createReadStream("./my-data.txt", {
  encoding: "utf8",
});

try {
  // Just loop over the stream like any other async iterable
  for await (const chunk of readableStream) {
    console.log("Got chunk:", chunk);
  }
  console.log("✓ Stream finished.");
} catch (err) {
  console.error("Error reading stream:", err);
}
