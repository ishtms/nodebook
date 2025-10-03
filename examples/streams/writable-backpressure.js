/**
 * Writable Stream - Backpressure Example
 *
 * Shows how to properly handle backpressure when writing to a stream.
 *
 * The Problem:
 * - If you write faster than the destination can handle, data buffers in memory
 * - This can cause your app to run out of memory and crash
 *
 * The Solution:
 * - .write() returns false when the internal buffer is full
 * - Stop writing when you get false
 * - Wait for the 'drain' event to resume writing
 *
 * This is critical for production apps. Ignoring backpressure = memory leaks.
 */

import { Writable } from "node:stream";

// Simulate a slow destination (like a slow network or disk)
const slowWriteStream = new Writable({
  write(chunk, encoding, callback) {
    console.log(`Writing chunk: "${chunk.toString()}"`);

    // Simulate slow I/O (network call, disk write, etc.)
    setTimeout(() => {
      console.log("...write complete.");
      callback(); // Tell the stream we're ready for next chunk
    }, 1000); // Takes 1 second per chunk
  },
});

let i = 0;

function writeLotsOfData() {
  while (i < 10) {
    i++;
    const data = `This is line number ${i}\n`;

    // write() returns true if you can keep writing
    // Returns false if buffer is full (backpressure signal)
    const canContinue = slowWriteStream.write(data);
    console.log(`Wrote line ${i}. Can continue? ${canContinue}`);

    if (!canContinue) {
      // Buffer is full, stop writing
      console.log("--- BACKPRESSURE --- Pausing writes.");

      // Wait for 'drain' event before continuing
      slowWriteStream.once("drain", () => {
        console.log("--- DRAIN EVENT --- Resuming writes.");
        writeLotsOfData(); // Resume
      });

      return; // Exit loop and wait
    }
  }

  // All done, end the stream
  slowWriteStream.end(() => {
    console.log("All writes finished!");
  });
}

// Start writing
writeLotsOfData();

slowWriteStream.on("finish", () => {
  console.log("✓ Writable stream finished.");
});

slowWriteStream.on("error", (err) => {
  console.error("Writable stream error:", err);
});
