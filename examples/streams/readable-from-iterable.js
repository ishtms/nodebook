/**
 * Readable Stream from Iterable Example
 *
 * Quick way to create a readable stream from arrays or any iterable.
 * Super useful for testing or working with in-memory data.
 *
 * Readable.from() converts any iterable into a stream.
 * Works with: arrays, strings, generators, async iterables, etc.
 */

import { Readable } from "node:stream";

// Create stream from an array
const dataStream = Readable.from([
  "line 1\n",
  "line 2\n",
  "line 3\n"
]);

// Pipe to stdout
dataStream.pipe(process.stdout);

// Also works with generators
function* generateData() {
  yield "First chunk\n";
  yield "Second chunk\n";
  yield "Third chunk\n";
}

console.log("From array:");
// Wait a bit then show generator example
setTimeout(() => {
  console.log("\nFrom generator:");
  const generatorStream = Readable.from(generateData());
  generatorStream.pipe(process.stdout);
}, 100);
