/**
 * thread-pool-intro.js
 * 
 * The Thread Pool Bottleneck Simulator!
 * 
 * This example demonstrates how libuv's thread pool works and, more importantly,
 * how it becomes a bottleneck when you have more work than threads.
 * 
 * DEFAULT SETUP:
 * - Thread pool size: 4 (unless UV_THREADPOOL_SIZE is set)
 * - Maximum size: 1024 (hardcoded in libuv)
 * - Threads are created lazily on first use
 * - Threads live for the entire process lifetime
 * 
 * RUN EXPERIMENTS:
 * - Default:        node thread-pool-intro.js
 * - More threads:   UV_THREADPOOL_SIZE=8 node thread-pool-intro.js
 * - Fewer threads:  UV_THREADPOOL_SIZE=2 node thread-pool-intro.js
 * - Single thread:  UV_THREADPOOL_SIZE=1 node thread-pool-intro.js (see serialization!)
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// Configuration
const THREAD_POOL_SIZE = process.env.UV_THREADPOOL_SIZE || 4;
const CRYPTO_ITERATIONS = 500000;  // Adjust based on your CPU speed
const CRYPTO_KEY_LENGTH = 512;

console.log('='.repeat(70));
console.log('THREAD POOL BOTTLENECK DEMONSTRATION');
console.log('='.repeat(70));
console.log(`Thread Pool Size: ${THREAD_POOL_SIZE}`);
console.log(`CPU Cores Available: ${require('os').cpus().length}`);
console.log(`Crypto Iterations: ${CRYPTO_ITERATIONS.toLocaleString()}`);
console.log('='.repeat(70) + '\n');

// Track timing for all operations
const operationTimings = new Map();
const startTime = Date.now();

// Helper function to log with timing
function logTiming(operation, phase = 'completed') {
  const elapsed = Date.now() - startTime;
  const timing = operationTimings.get(operation);
  
  if (phase === 'started') {
    operationTimings.set(operation, { start: elapsed });
    console.log(`[${String(elapsed).padStart(5)}ms] 🚀 ${operation} started`);
  } else {
    const duration = timing ? elapsed - timing.start : elapsed;
    console.log(`[${String(elapsed).padStart(5)}ms] ✓ ${operation} ${phase} (took ${duration}ms)`);
  }
}

// =============================================================================
// EXPERIMENT 1: Saturating the Thread Pool with Crypto
// =============================================================================
console.log('EXPERIMENT 1: CPU-Intensive Crypto Operations');
console.log('-'.repeat(50));
console.log(`Queuing ${THREAD_POOL_SIZE + 2} crypto operations...\n`);

// Helper function to run a crypto operation
function runCryptoOperation(id) {
  logTiming(`Crypto #${id}`, 'started');
  
  // pbkdf2 is perfect for this demo because:
  // 1. It's CPU-intensive (designed to be slow)
  // 2. It always uses the thread pool
  // 3. The duration is predictable based on iterations
  
  crypto.pbkdf2(`password${id}`, 'salt', CRYPTO_ITERATIONS, CRYPTO_KEY_LENGTH, 'sha512', (err, key) => {
    if (err) throw err;
    logTiming(`Crypto #${id}`, 'completed');
    
    // Show which operations likely ran in parallel
    if (id <= THREAD_POOL_SIZE) {
      console.log(`    └─ Likely ran in parallel (one of the first ${THREAD_POOL_SIZE} threads)`);
    } else {
      console.log(`    └─ Had to wait for a thread to become available`);
    }
  });
}

// Queue up more operations than we have threads
for (let i = 1; i <= THREAD_POOL_SIZE + 2; i++) {
  runCryptoOperation(i);
}

// Notice how the first 4 (or UV_THREADPOOL_SIZE) operations complete around
// the same time, while operation 5 and 6 complete much later!

// =============================================================================
// EXPERIMENT 2: Mixed Operations Competing for Threads
// =============================================================================
setTimeout(() => {
  console.log('\n' + '='.repeat(70));
  console.log('EXPERIMENT 2: Mixed Operations (Crypto + File I/O)');
  console.log('-'.repeat(50));
  console.log('Starting mixed workload...\n');
  
  const mixedStartTime = Date.now();
  let completedOps = 0;
  const totalOps = 6;
  
  // Start 3 crypto operations
  for (let i = 1; i <= 3; i++) {
    logTiming(`Mixed-Crypto #${i}`, 'started');
    crypto.pbkdf2('password', 'salt', CRYPTO_ITERATIONS / 2, 256, 'sha512', () => {
      logTiming(`Mixed-Crypto #${i}`);
      completedOps++;
      checkMixedComplete();
    });
  }
  
  // Interleave with 3 file operations
  for (let i = 1; i <= 3; i++) {
    logTiming(`Mixed-File #${i}`, 'started');
    fs.readFile(__filename, 'utf8', () => {
      logTiming(`Mixed-File #${i}`);
      completedOps++;
      checkMixedComplete();
    });
  }
  
  function checkMixedComplete() {
    if (completedOps === totalOps) {
      const totalTime = Date.now() - mixedStartTime;
      console.log(`\nMixed operations total time: ${totalTime}ms`);
      console.log('Notice: File ops completed quickly even with crypto running!');
      console.log('Why? File reads are fast, crypto is slow but both use same pool.');
      
      runExperiment3();
    }
  }
}, 5000);

// =============================================================================
// EXPERIMENT 3: Thread Pool Starvation
// =============================================================================
function runExperiment3() {
  console.log('\n' + '='.repeat(70));
  console.log('EXPERIMENT 3: Thread Pool Starvation');
  console.log('-'.repeat(50));
  console.log('What happens when we queue MANY operations?\n');
  
  const TOTAL_OPERATIONS = 20;
  let completed = 0;
  const starvationStart = Date.now();
  
  // Create a large file to make reads more noticeable
  const testFile = path.join(__dirname, 'test-large.tmp');
  const largeContent = Buffer.alloc(10 * 1024 * 1024, 'x'); // 10MB
  
  console.log('Creating 10MB test file...');
  fs.writeFileSync(testFile, largeContent);
  
  console.log(`Queuing ${TOTAL_OPERATIONS} file read operations...\n`);
  
  // Queue many file operations
  for (let i = 1; i <= TOTAL_OPERATIONS; i++) {
    // Don't log start for each to avoid spam
    const opStart = Date.now();
    
    fs.readFile(testFile, (err) => {
      if (err) throw err;
      completed++;
      const duration = Date.now() - opStart;
      
      // Only log the interesting ones
      if (completed <= THREAD_POOL_SIZE || 
          completed === TOTAL_OPERATIONS || 
          completed % 5 === 0) {
        console.log(`[${String(Date.now() - startTime).padStart(5)}ms] ` +
                   `File Read #${completed}/${TOTAL_OPERATIONS} completed (waited ${duration}ms)`);
      }
      
      if (completed === TOTAL_OPERATIONS) {
        const totalTime = Date.now() - starvationStart;
        console.log(`\nAll operations completed in: ${totalTime}ms`);
        console.log(`Average time per operation: ${Math.round(totalTime / TOTAL_OPERATIONS)}ms`);
        console.log(`Theoretical minimum (if all parallel): ${Math.round(totalTime / TOTAL_OPERATIONS * THREAD_POOL_SIZE)}ms`);
        
        // Cleanup
        fs.unlinkSync(testFile);
        runExperiment4();
      }
    });
  }
}

// =============================================================================
// EXPERIMENT 4: Demonstrating Thread Pool vs Native Async
// =============================================================================
function runExperiment4() {
  console.log('\n' + '='.repeat(70));
  console.log('EXPERIMENT 4: Thread Pool vs Native Async');
  console.log('-'.repeat(50));
  console.log('Comparing operations that use threads vs those that don\'t\n');
  
  const net = require('net');
  let completedOps = 0;
  const totalOps = 10;
  
  console.log('Starting 5 thread pool operations (DNS lookups)...');
  // DNS lookups use the thread pool
  for (let i = 1; i <= 5; i++) {
    const host = `example${i}.com`;
    const dns = require('dns');
    dns.lookup(host, (err) => {
      // Ignore errors, we just care about the thread pool usage
      console.log(`  ✓ DNS lookup #${i} completed (used thread pool)`);
      completedOps++;
      checkExperiment4Complete();
    });
  }
  
  console.log('Starting 5 native async operations (timers)...');
  // Timers don't use the thread pool at all
  for (let i = 1; i <= 5; i++) {
    setTimeout(() => {
      console.log(`  ✓ Timer #${i} completed (no thread needed)`);
      completedOps++;
      checkExperiment4Complete();
    }, 100 * i);
  }
  
  function checkExperiment4Complete() {
    if (completedOps === totalOps) {
      showFinalSummary();
    }
  }
}

// =============================================================================
// FINAL SUMMARY AND EDUCATIONAL NOTES
// =============================================================================
function showFinalSummary() {
  console.log('\n' + '='.repeat(70));
  console.log('THREAD POOL INSIGHTS & BEST PRACTICES');
  console.log('='.repeat(70));
  
  console.log(`
WHAT YOU'VE LEARNED:

1. DEFAULT SIZE MATTERS:
   • Only ${THREAD_POOL_SIZE} threads handle ALL thread pool operations
   • This includes: file I/O, DNS lookups, crypto, and more
   • Operations beyond thread count must wait

2. BOTTLENECK INDICATORS:
   • First ${THREAD_POOL_SIZE} operations complete together
   • Additional operations show clear delay
   • Mixed workloads can starve each other

3. THREAD POOL OPERATIONS:
   ✓ fs.* (most file operations)
   ✓ dns.lookup() 
   ✓ crypto.pbkdf2(), crypto.randomBytes(), etc.
   ✓ some user native addons
   
4. NON-THREAD POOL OPERATIONS:
   ✓ Network I/O (TCP, UDP, HTTP)
   ✓ Timers (setTimeout, setInterval)
   ✓ dns.resolve*() functions
   ✓ Child processes

OPTIMIZATION STRATEGIES:

For I/O-Heavy Apps:
  UV_THREADPOOL_SIZE=64 node app.js
  (Increase thread pool for more parallel I/O)

For CPU-Heavy Apps:
  - Consider worker threads instead
  - Or use cluster to leverage multiple cores
  - Thread pool isn't ideal for CPU work

For Mixed Workloads:
  - Separate CPU work into worker threads
  - Keep thread pool for I/O operations
  - Monitor thread pool saturation

MONITORING TIPS:
  - Track operation completion times
  - Watch for queueing delays
  - Consider async alternatives (e.g., dns.resolve vs dns.lookup)
  - Use native async operations when possible

Remember: The thread pool is a shared resource. 
One slow operation type can block all others!
`);
  
  console.log('Demonstration complete!');
  process.exit(0);
}