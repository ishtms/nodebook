/**
 * Readable Stream - Paused Mode Example
 *
 * Shows how to read from a stream in paused mode.
 * In paused mode, YOU control when to pull data - the stream won't push it to you.
 *
 * Key points:
 * - Streams start in paused mode by default
 * - Call .read() to pull data out
 * - 'readable' event = "hey, I have data for you"
 * - .read() returns null when buffer is empty
 * - 'end' event = no more data coming
 *
 * Use this when you need full control over when data gets processed.
 */

import { writeFile } from "node:fs/promises";
import fs from "node:fs";

// Create a dummy file first
await writeFile(
  "./my-data.txt",
  "Here is some data that will be streamed chunk by chunk."
);

// Create readable stream
// encoding: 'utf8' converts Buffers to strings for us
const readableStream = fs.createReadStream("./my-data.txt", {
  encoding: "utf8",
});

// Stream starts in PAUSED mode.
// Listen for 'readable' to know when data is ready
readableStream.on("readable", () => {
  console.log("--> Stream is readable (data in buffer)");
  let chunk;

  // Keep calling .read() until it returns null
  // This makes sure we get everything from the buffer
  while (null !== (chunk = readableStream.read())) {
    console.log(`Received chunk of size ${chunk.length}:`);
    console.log(`"${chunk}"\n`);
  }

  // Buffer is now empty, wait for next 'readable' event
});

// 'end' fires once when stream is done
readableStream.on("end", () => {
  console.log("--> Reached end of stream.");
  console.log("✓ Done reading in paused mode.");
});

// Always handle errors or your process will crash
readableStream.on("error", (err) => {
  console.error("Error while reading:", err);
});
