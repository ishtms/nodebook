/**
 * Transform Stream - Gzip Compression Example
 *
 * Transform streams modify data as it passes through.
 * Input goes in one side, transformed output comes out the other.
 *
 * This example compresses a file using gzip.
 * - Source: reads file chunk by chunk
 * - Transform: compresses each chunk
 * - Destination: writes compressed data to new file
 *
 * The beauty: entire file is NEVER loaded into memory.
 * Works the same for 1KB or 10GB files.
 */

import fs from "node:fs";
import zlib from "node:zlib";

// Source: read from file
const source = fs.createReadStream("./my-data.txt");

// Destination: write to compressed file
const destination = fs.createWriteStream("./my-data.txt.gz");

// Transform: gzip compression
const gzip = zlib.createGzip();

console.log("Starting compression...");

// Build the pipeline: source → gzip → destination
source
  .pipe(gzip) // Data flows from source into gzip
  .pipe(destination); // Compressed data flows into destination

// Listen on the final destination
destination.on("finish", () => {
  console.log("✓ File compression complete.");
});

// Handle errors at each stage
source.on("error", (err) => console.error("Source error:", err));
gzip.on("error", (err) => console.error("Gzip error:", err));
destination.on("error", (err) => console.error("Destination error:", err));
