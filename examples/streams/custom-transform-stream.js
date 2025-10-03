/**
 * Custom Transform Stream Example
 *
 * Transform streams are the most useful to build.
 * They sit between readable and writable, modifying data as it flows through.
 *
 * How it works:
 * - Extend Transform class
 * - Implement _transform(chunk, encoding, callback)
 * - Process the chunk
 * - Call this.push(result) to send data downstream
 * - Call callback() when done
 * - Optional: implement _flush(callback) for cleanup
 *
 * You can push 0, 1, or many times per input chunk.
 * _flush() is called right before stream ends - last chance to emit data.
 */

import { Transform } from "node:stream";
import fs from "node:fs";
import { writeFile } from "node:fs/promises";

class UppercaseTransform extends Transform {
  constructor(options) {
    super(options);
  }

  _transform(chunk, encoding, callback) {
    // Convert chunk to uppercase
    const uppercasedChunk = chunk.toString().toUpperCase();

    // Push to readable side (downstream consumers)
    this.push(uppercasedChunk);

    // Signal we're ready for next chunk
    callback();
  }
}

// Create test file
await writeFile(
  "./lowercase-data.txt",
  "this is a test.\nhello world.\nend of file."
);

const source = fs.createReadStream("./lowercase-data.txt");
const uppercaser = new UppercaseTransform();
const destination = process.stdout;

console.log("Starting uppercasing pipeline:");
console.log("---");

// Pipeline: source → uppercaser → stdout
source.pipe(uppercaser).pipe(destination);

source.on("end", () => {
  console.log("---");
  console.log("✓ Pipeline complete.");
});
