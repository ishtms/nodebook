const { performance } = require("node:perf_hooks");

const ITERATIONS = 10000;

/**
 * A helper function to run and time a specific buffer allocation method.
 * @param {string} name - The name of the benchmark to display.
 * @param {number} size - The size of the buffer to allocate.
 * @param {(size: number) => Buffer} allocFn - The allocation function to benchmark.
 */
function benchmark(name, size, allocFn) {
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    allocFn(size);
  }
  const end = performance.now();
  console.log(`- ${name}(${size}) x ${ITERATIONS}: ${(end - start).toFixed(2)}ms`);
}

console.log("--- Benchmarking Buffer Allocation ---");
console.log(`(Iterations: ${ITERATIONS}, Node.js: ${process.version})`);

// --- Scenario 1: Small allocations that use the internal buffer pool ---
console.log("\nScenario 1: Small Allocations (100 bytes, pooled)");
benchmark("Buffer.alloc", 100, (s) => Buffer.alloc(s));
benchmark("Buffer.allocUnsafe", 100, (s) => Buffer.allocUnsafe(s));

// --- Scenario 2: Medium allocations just above the pool size ---
console.log("\nScenario 2: Medium Allocations (10KB, non-pooled)");
const mediumSize = 10 * 1024;
benchmark("Buffer.alloc", mediumSize, (s) => Buffer.alloc(s));
benchmark("Buffer.allocUnsafe", mediumSize, (s) => Buffer.allocUnsafe(s));

// --- Scenario 3: Large allocations where zero-filling is very expensive ---
console.log("\nScenario 3: Large Allocations (1MB, non-pooled)");
const largeSize = 1024 * 1024;
benchmark("Buffer.alloc", largeSize, (s) => Buffer.alloc(s));
benchmark("Buffer.allocUnsafe", largeSize, (s) => Buffer.allocUnsafe(s));

// --- Benchmarking Buffer.from() convenience methods ---
console.log("\n--- Benchmarking Buffer.from ---");

// Setup for Buffer.from tests
const largeString = "a".repeat(largeSize);
const existingLargeBuffer = Buffer.alloc(largeSize);

// Test creating a buffer from a large string
let start = performance.now();
Buffer.from(largeString, "utf8");
let end = performance.now();
console.log(`- Buffer.from(1MB string): ${(end - start).toFixed(2)}ms`);

// Test creating a buffer as a copy of another buffer
start = performance.now();
Buffer.from(existingLargeBuffer);
end = performance.now();
console.log(`- Buffer.from(1MB buffer, copy): ${(end - start).toFixed(2)}ms`);
