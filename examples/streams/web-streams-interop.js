/**
 * Web Streams Interoperability Example
 *
 * Node.js has TWO stream APIs:
 * 1. Node streams (what we've been using)
 * 2. Web Streams (WHATWG standard, same as browsers)
 *
 * Web Streams API:
 * - ReadableStream (like Node's Readable)
 * - WritableStream (like Node's Writable)
 * - TransformStream (like Node's Transform)
 *
 * When to use each:
 * - Node streams: Node.js-specific code (fs, net, http)
 * - Web Streams: Cross-runtime code (works in browsers, Deno, etc.)
 *
 * Node provides utilities to convert between them.
 */

import { Readable } from "node:stream";

// Create a Node readable stream
const nodeStream = Readable.from([
  "chunk 1\n",
  "chunk 2\n",
  "chunk 3\n"
]);

// Convert Node stream to Web ReadableStream
const webStream = Readable.toWeb(nodeStream);
console.log("Converted to Web ReadableStream:", webStream.constructor.name);

// Convert Web ReadableStream back to Node stream
const backToNode = Readable.fromWeb(webStream);

// Consume as normal Node stream
console.log("\nReading from converted stream:");
for await (const chunk of backToNode) {
  console.log("Chunk:", chunk);
}

console.log("\n✓ Conversion works in both directions.");
