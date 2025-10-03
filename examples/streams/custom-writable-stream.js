/**
 * Custom Writable Stream Example
 *
 * Shows how to build your own writable stream.
 * Extend Writable class and implement _write() method.
 *
 * How it works:
 * - Node calls _write() when someone writes data to your stream
 * - You process the chunk (save to DB, send over network, etc.)
 * - MUST call callback() when done - this is critical!
 * - callback() = "I'm ready for next chunk"
 * - callback(error) = "Something went wrong"
 *
 * Forgetting to call callback() will freeze the stream forever.
 */

import { Writable, Readable } from "node:stream";

class LoggingWritable extends Writable {
  constructor(options) {
    super(options);
  }

  // Called for every chunk written to this stream
  _write(chunk, encoding, callback) {
    const data = chunk.toString().trim();
    console.log(`[LoggingWritable] Received: "${data}"`);

    // Simulate async operation (DB write, network call, etc.)
    setTimeout(() => {
      console.log("[LoggingWritable] ...processed successfully.");

      // CRITICAL: Call callback to signal we're ready for next chunk
      callback();
    }, 500);
  }
}

// Simple readable source for testing
class DataSource extends Readable {
  constructor(options) {
    super(options);
    this.index = 0;
  }

  _read(size) {
    this.index++;
    if (this.index > 5) {
      this.push(null); // End stream
    } else {
      this.push(`Data item ${this.index}\n`);
    }
  }
}

const source = new DataSource();
const logger = new LoggingWritable();

// Pipe source to our custom writable
// pipe() handles backpressure automatically
source.pipe(logger);

logger.on("finish", () => {
  console.log("✓ LoggingWritable finished processing all data.");
});
