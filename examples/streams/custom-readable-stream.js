/**
 * Custom Readable Stream Example
 *
 * Shows how to build your own readable stream.
 * Extend Readable class and implement _read() method.
 *
 * How it works:
 * - _read() is called by Node when consumer needs data
 * - You fetch data from your source (DB, API, generator, etc.)
 * - Call this.push(data) to send it to consumer
 * - Call this.push(null) when done
 * - this.push() returns false when buffer is full (stop pushing)
 *
 * The consumer controls the pace - if they're slow, _read() won't be called as often.
 */

import { Readable } from "node:stream";

class RandomNumberStream extends Readable {
  constructor(maxIterations, options) {
    super(options);
    this.maxIterations = maxIterations;
    this.currentIteration = 0;
  }

  // Node calls this when it wants more data
  _read(size) {
    if (this.currentIteration >= this.maxIterations) {
      // No more data, end the stream
      this.push(null);
      return;
    }

    // Generate data
    const randomNumber = Math.floor(Math.random() * 100);
    const dataChunk = `Random Number: ${randomNumber}\n`;

    console.log(`Pushing to buffer: "${dataChunk.trim()}"`);

    // Push data to internal buffer
    // If it returns false, buffer is full (we should stop)
    // For this simple example, we push once per _read call
    this.push(dataChunk);

    this.currentIteration++;
  }
}

// Use our custom stream
const randomNumberStream = new RandomNumberStream(5);

// Pipe to stdout (console)
randomNumberStream.pipe(process.stdout);

randomNumberStream.on("end", () => {
  console.log("✓ Stream ended.");
});
