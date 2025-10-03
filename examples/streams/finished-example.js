/**
 * stream.finished() Example
 *
 * Utility to know when a stream is done, regardless of how it ended.
 * Works for: successful end, error, or premature close.
 *
 * Why use this:
 * - Don't need to listen to 'end', 'finish', 'error', 'close' separately
 * - Single callback for all completion scenarios
 * - Reliable detection of stream completion
 *
 * Useful when you need to know "is this stream definitely done?"
 */

import fs from "node:fs";
import { finished } from "node:stream";

const writable = fs.createWriteStream("./temp-file.txt");

// finished() gives single callback for any completion
finished(writable, (err) => {
  if (err) {
    console.error("✗ Stream failed:", err);
  } else {
    console.log("✓ Stream finished successfully.");
  }
});

writable.write("Some data\n");
writable.write("More data\n");
writable.end("Last bit of data.");
