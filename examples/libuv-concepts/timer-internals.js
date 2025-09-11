/**
 * timer-internals.js
 * 
 * The Great Race: setTimeout(0) vs setImmediate
 * 
 * This is one of the most misunderstood aspects of Node.js. The execution
 * order between setTimeout(fn, 0) and setImmediate() can seem random, but
 * it's actually deterministic based on WHERE and WHEN they're called.
 * 
 * This example demonstrates the non-deterministic behavior and explains
 * exactly why it happens. Run this multiple times to see the variance!
 * 
 * SPOILER: It's all about event loop phases and timing precision.
 */

const fs = require('fs');
const { performance } = require('perf_hooks');

console.log('='.repeat(70));
console.log('TIMER INTERNALS: The setTimeout vs setImmediate Race');
console.log('='.repeat(70));
console.log('Run this multiple times to see different results!\n');

// =============================================================================
// RACE 1: From Main Module (Non-Deterministic)
// =============================================================================
console.log('RACE 1: From Main Module');
console.log('-'.repeat(50));

const scriptStart = performance.now();

// These two are racing! Who wins?
setTimeout(() => {
  const elapsed = performance.now() - scriptStart;
  console.log(`  setTimeout(0) executed after ${elapsed.toFixed(3)}ms`);
}, 0);

setImmediate(() => {
  const elapsed = performance.now() - scriptStart;
  console.log(`  setImmediate executed after ${elapsed.toFixed(3)}ms`);
});

console.log('  [Scheduled both - the race begins!]');

// Why is the order unpredictable?
// 
// EXPLANATION:
// 1. setTimeout(fn, 0) actually means setTimeout(fn, 1) internally (minimum 1ms)
// 2. When the event loop starts, it checks the timer phase first
// 3. If less than 1ms has passed since scheduling, the timer isn't "expired" yet
// 4. So the loop continues to the check phase where setImmediate runs
// 5. BUT if the process is slow and 1ms HAS passed, the timer runs first!
//
// The winner depends on system performance at that exact moment!

// =============================================================================
// RACE 2: From Within I/O Callback (Deterministic!)
// =============================================================================
setTimeout(() => {
  console.log('\nRACE 2: From Within I/O Callback');
  console.log('-'.repeat(50));
  
  fs.readFile(__filename, () => {
    const ioCallbackStart = performance.now();
    console.log('  [Inside I/O callback - scheduling both]');
    
    // When scheduled from I/O, the order is ALWAYS predictable
    setTimeout(() => {
      const elapsed = performance.now() - ioCallbackStart;
      console.log(`  setTimeout(0) from I/O - executed after ${elapsed.toFixed(3)}ms`);
    }, 0);
    
    setImmediate(() => {
      const elapsed = performance.now() - ioCallbackStart;
      console.log(`  setImmediate from I/O - executed after ${elapsed.toFixed(3)}ms`);
    });
    
    // EXPLANATION:
    // We're currently in the POLL phase (executing I/O callback)
    // Next phase is CHECK (where setImmediate runs)
    // Timers phase comes at the start of the NEXT loop iteration
    // So setImmediate ALWAYS wins when called from I/O!
  });
}, 100);

// =============================================================================
// DEMONSTRATION: Timer Minimum Threshold
// =============================================================================
setTimeout(() => {
  console.log('\nDEMONSTRATION: Timer Minimum Threshold');
  console.log('-'.repeat(50));
  console.log('Even setTimeout(0) has a minimum delay...\n');
  
  const timings = [];
  let completed = 0;
  const total = 10;
  
  for (let i = 0; i < total; i++) {
    const start = performance.now();
    
    setTimeout(() => {
      const actual = performance.now() - start;
      timings.push(actual);
      completed++;
      
      console.log(`  Timer ${i}: Requested 0ms, actual ${actual.toFixed(3)}ms`);
      
      if (completed === total) {
        const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
        const min = Math.min(...timings);
        const max = Math.max(...timings);
        
        console.log(`\n  Statistics:`);
        console.log(`    Average delay: ${avg.toFixed(3)}ms`);
        console.log(`    Minimum delay: ${min.toFixed(3)}ms`);
        console.log(`    Maximum delay: ${max.toFixed(3)}ms`);
        console.log(`    Note: Rarely exactly 0ms due to internal minimums!`);
      }
    }, 0);
  }
}, 300);

// =============================================================================
// ADVANCED: Multiple Timers and Phase Batching
// =============================================================================
setTimeout(() => {
  console.log('\nADVANCED: Timer Batching and Phase Execution');
  console.log('-'.repeat(50));
  
  // Schedule multiple timers with same timeout
  const batchStart = performance.now();
  
  // These all have the same timeout, so they'll execute in the same phase
  for (let i = 1; i <= 3; i++) {
    setTimeout(() => {
      console.log(`  Batch Timer ${i} (same timeout, same phase)`);
    }, 10);
  }
  
  // Different timeout = different phase iteration
  setTimeout(() => {
    console.log(`  Different Timer (20ms, next timer phase)`);
  }, 20);
  
  // Immediate for comparison
  setImmediate(() => {
    console.log(`  Immediate (runs in check phase)`);
  });
  
  console.log('  [Scheduled batch - they\'ll run together]');
}, 600);

// =============================================================================
// EXPERIMENT: Timer Precision Limits
// =============================================================================
setTimeout(() => {
  console.log('\nEXPERIMENT: Timer Precision and System Load');
  console.log('-'.repeat(50));
  
  // Let's see how precise our timers really are
  const precisionTests = [0, 1, 2, 5, 10];
  let testIndex = 0;
  
  function runPrecisionTest() {
    if (testIndex >= precisionTests.length) {
      showTimerInternals();
      return;
    }
    
    const requested = precisionTests[testIndex++];
    const start = performance.now();
    
    setTimeout(() => {
      const actual = performance.now() - start;
      const drift = actual - requested;
      console.log(`  Requested: ${requested}ms, Actual: ${actual.toFixed(3)}ms, Drift: ${drift > 0 ? '+' : ''}${drift.toFixed(3)}ms`);
      runPrecisionTest();
    }, requested);
  }
  
  console.log('Testing timer precision...\n');
  runPrecisionTest();
}, 1000);

// =============================================================================
// DEEP DIVE: Timer Implementation Details
// =============================================================================
function showTimerInternals() {
  console.log('\n' + '='.repeat(70));
  console.log('TIMER INTERNALS EXPLAINED');
  console.log('='.repeat(70));
  console.log(`
HOW TIMERS ACTUALLY WORK:

1. TIMER CREATION:
   • setTimeout creates a Timeout object
   • Added to internal timer list (sorted by expiration)
   • Timers are stored in a binary heap (min-heap)

2. TIMER PHASE EXECUTION:
   • Event loop enters timer phase
   • Checks current time (uv_now)
   • Processes all timers where: now >= timer.expiration
   • Executes callbacks in order

3. THE setTimeout(0) MYTH:
   • Internally becomes setTimeout(1)
   • Minimum delay of 1ms enforced
   • Can be delayed by system load

4. setImmediate ADVANTAGE:
   • No minimum delay
   • Guaranteed to run after I/O events
   • More predictable than setTimeout(0)

5. TIMER ACCURACY FACTORS:
   • System clock resolution (varies by OS)
   • CPU load and process scheduling
   • Event loop block time
   • Number of timers in queue

RACE CONDITION SUMMARY:

From Main Module:
  setTimeout(0) vs setImmediate = UNPREDICTABLE
  Depends on process startup time

From I/O Callback:
  setTimeout(0) vs setImmediate = setImmediate WINS
  Due to event loop phase ordering

BEST PRACTICES:

✓ Use setImmediate for "next tick" operations
✓ Use process.nextTick sparingly (can starve loop)
✓ Don't rely on precise timer delays
✓ Consider timer phase when scheduling
✓ Remember: Timers are minimums, not guarantees!

PERFORMANCE TIP:
If you need to run something "as soon as possible":
  1st choice: process.nextTick (but use carefully!)
  2nd choice: setImmediate (from I/O callbacks)
  3rd choice: setTimeout(0) (least predictable)
`);
}

// =============================================================================
// BONUS: Demonstrating Phase Order Impact
// =============================================================================
setTimeout(() => {
  console.log('\nBONUS: Why Phase Order Matters');
  console.log('-'.repeat(50));
  
  // Create a situation showing phase importance
  let order = [];
  
  // All scheduled at the same time
  setTimeout(() => order.push('timer') && checkOrder(), 0);
  setImmediate(() => order.push('immediate') && checkOrder());
  process.nextTick(() => order.push('nextTick') && checkOrder());
  Promise.resolve().then(() => order.push('promise') && checkOrder());
  
  function checkOrder() {
    if (order.length === 4) {
      console.log(`  Execution order: ${order.join(' → ')}`);
      console.log(`  Notice: Microtasks (nextTick, promise) always come first!`);
      
      // Final message and exit
      setTimeout(() => {
        console.log('\n' + '='.repeat(70));
        console.log('Run this example multiple times to see the variance!');
        console.log('The setTimeout vs setImmediate race from main will change.');
        console.log('='.repeat(70));
        process.exit(0);
      }, 100);
    }
  }
}, 1800);