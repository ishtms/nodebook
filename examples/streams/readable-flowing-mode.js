/**
 * Readable Stream - Flowing Mode Example
 *
 * In flowing mode, the stream pushes data to you automatically.
 * You just listen for 'data' events and handle chunks as they arrive.
 *
 * Key points:
 * - Adding a 'data' listener automatically switches stream to flowing mode
 * - Stream pushes data to you as fast as it can read it
 * - You don't call .read() - data comes to you
 * - Risk: if source is faster than you can process, could cause issues (backpressure handles this)
 *
 * This is simpler than paused mode, but less control.
 */

import fs from "node:fs";

const readableStream = fs.createReadStream("./my-data.txt", {
  encoding: "utf8",
});

// By adding a 'data' listener, we automatically switch to FLOWING mode
// Data will be pushed to us - we don't ask for it
readableStream.on("data", (chunk) => {
  console.log("--> Received a chunk of data:");
  console.log(`"${chunk}"\n`);
});

// 'end' still tells us when we're done
readableStream.on("end", () => {
  console.log("--> Reached end of stream.");
  console.log("✓ Done reading in flowing mode.");
});

// Always handle errors
readableStream.on("error", (err) => {
  console.error("Error:", err);
});
