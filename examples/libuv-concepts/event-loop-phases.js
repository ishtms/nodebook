/**
 * event-loop-phases.js
 * 
 * The Event Loop Symphony: Understanding the Six Phases
 * 
 * The Node.js event loop isn't just a simple queue - it's a sophisticated
 * multi-phase system. Each phase has a specific purpose and a FIFO queue
 * of callbacks to execute. Understanding these phases is crucial for
 * predicting execution order and optimizing performance.
 * 
 * THE SIX PHASES (in order):
 * 1. Timers Phase         - Execute setTimeout/setInterval callbacks
 * 2. Pending Callbacks    - Execute I/O callbacks deferred from previous loop
 * 3. Idle, Prepare        - Internal use only (we can't interact with these)
 * 4. Poll Phase           - Retrieve new I/O events; execute I/O callbacks
 * 5. Check Phase          - Execute setImmediate callbacks
 * 6. Close Callbacks      - Execute close event callbacks (e.g., socket.on('close'))
 * 
 * PLUS: Microtasks (process.nextTick and Promises) run between phases!
 */

const fs = require('fs');
const net = require('net');

console.log('='.repeat(70));
console.log('EVENT LOOP PHASES DEMONSTRATION');
console.log('='.repeat(70));
console.log('Watch the execution order to understand phase transitions!\n');

// Helper to show which phase we're likely in
let phaseCounter = 0;
function logPhase(message, phase) {
  console.log(`[${++phaseCounter}] ${phase.padEnd(20)} | ${message}`);
}

// =============================================================================
// IMMEDIATE EXECUTION (Main Module)
// =============================================================================
console.log('[MAIN] Script starts - this runs before event loop begins');

// =============================================================================
// MICROTASKS - The Queue Jumpers!
// =============================================================================
// process.nextTick() and Promise.then() are "microtasks"
// They run AFTER the current phase completes but BEFORE the next phase

process.nextTick(() => {
  logPhase('process.nextTick from main', 'MICROTASK');
  
  // Nested nextTicks still run before moving to next phase
  process.nextTick(() => {
    logPhase('Nested nextTick', 'MICROTASK');
  });
});

Promise.resolve().then(() => {
  logPhase('Promise.resolve from main', 'MICROTASK');
});

// =============================================================================
// PHASE 1: TIMERS
// =============================================================================
// Timers are checked at the beginning of each event loop iteration.
// If enough time has passed, their callbacks execute.

setTimeout(() => {
  logPhase('setTimeout(..., 0) executed', 'TIMERS PHASE');
  
  // Scheduling from within a timer
  process.nextTick(() => {
    logPhase('nextTick from timer', 'MICROTASK');
  });
  
  // This will run in the NEXT loop's timer phase
  setTimeout(() => {
    logPhase('Nested setTimeout', 'TIMERS PHASE');
  }, 0);
  
  // This will run in the check phase of THIS loop
  setImmediate(() => {
    logPhase('setImmediate from timer', 'CHECK PHASE');
  });
}, 0);

// Multiple timers with same timeout
setTimeout(() => logPhase('Timer A (0ms)', 'TIMERS PHASE'), 0);
setTimeout(() => logPhase('Timer B (0ms)', 'TIMERS PHASE'), 0);
setTimeout(() => logPhase('Timer C (10ms)', 'TIMERS PHASE'), 10);

// =============================================================================
// PHASE 4: POLL (I/O Callbacks)
// =============================================================================
// The poll phase is where most of the action happens.
// It has two main functions:
// 1. Execute scripts for timers whose threshold has elapsed
// 2. Process events in the poll queue

fs.readFile(__filename, 'utf8', (err, data) => {
  if (err) throw err;
  logPhase('File read callback', 'POLL PHASE');
  
  // Let's see the phase ordering from within I/O
  
  // Microtasks run immediately after this callback
  process.nextTick(() => {
    logPhase('nextTick from I/O', 'MICROTASK');
  });
  
  Promise.resolve().then(() => {
    logPhase('Promise from I/O', 'MICROTASK');
  });
  
  // setImmediate is guaranteed to run before setTimeout when inside I/O
  setImmediate(() => {
    logPhase('setImmediate from I/O (runs first)', 'CHECK PHASE');
  });
  
  setTimeout(() => {
    logPhase('setTimeout from I/O (runs second)', 'TIMERS PHASE');
  }, 0);
  
  // Multiple file operations to show poll queue
  fs.readFile(__filename, () => {
    logPhase('Second file read from I/O', 'POLL PHASE');
  });
});

// Another I/O operation
fs.stat(__filename, (err, stats) => {
  if (err) throw err;
  logPhase(`File stat callback (size: ${stats.size})`, 'POLL PHASE');
});

// =============================================================================
// PHASE 5: CHECK (setImmediate)
// =============================================================================
// setImmediate callbacks are executed here.
// This phase allows you to execute callbacks immediately after poll phase.

setImmediate(() => {
  logPhase('setImmediate from main', 'CHECK PHASE');
  
  // Chaining immediates
  setImmediate(() => {
    logPhase('Chained setImmediate', 'CHECK PHASE');
    
    // This creates an interesting pattern
    setImmediate(() => {
      logPhase('Double-chained setImmediate', 'CHECK PHASE');
    });
  });
});

// Multiple immediates execute in order
setImmediate(() => logPhase('setImmediate A', 'CHECK PHASE'));
setImmediate(() => logPhase('setImmediate B', 'CHECK PHASE'));

// =============================================================================
// PHASE 6: CLOSE CALLBACKS
// =============================================================================
// Callbacks for closed resources execute here

const server = net.createServer();
server.listen(0, () => {  // Port 0 = random available port
  const port = server.address().port;
  logPhase(`Server listening on port ${port}`, 'POLL PHASE');
  
  // Close immediately to trigger close callback
  server.close(() => {
    logPhase('Server close callback', 'CLOSE CALLBACKS');
  });
});

// Another example with a socket
const socket = new net.Socket();
socket.on('close', () => {
  logPhase('Socket close callback', 'CLOSE CALLBACKS');
});

// Try to connect to non-existent server (will fail and close)
socket.connect({ port: 1, host: '127.0.0.1' });
socket.on('error', () => {
  // Silently handle error, we just want the close event
  socket.destroy();
});

// =============================================================================
// DEMONSTRATION: Phase Order Visibility
// =============================================================================

// Let's create a situation that clearly shows phase transitions
setTimeout(() => {
  console.log('\n' + '='.repeat(70));
  console.log('PHASE TRANSITION DEMONSTRATION');
  console.log('='.repeat(70) + '\n');
  
  let transitionCounter = 0;
  
  // This runs in TIMERS phase
  console.log(`[T${++transitionCounter}] We're now in TIMERS phase`);
  
  // Schedule for different phases
  process.nextTick(() => {
    console.log(`[T${++transitionCounter}] MICROTASK runs before next phase`);
  });
  
  setImmediate(() => {
    console.log(`[T${++transitionCounter}] CHECK phase comes after poll`);
    
    process.nextTick(() => {
      console.log(`[T${++transitionCounter}] MICROTASK after check phase`);
    });
    
    // This goes to NEXT iteration's timers phase
    setTimeout(() => {
      console.log(`[T${++transitionCounter}] Back to TIMERS (next iteration)`);
    }, 0);
  });
  
  // Trigger some I/O to see poll phase
  fs.readFile(__filename, () => {
    console.log(`[T${++transitionCounter}] POLL phase (I/O callback)`);
    
    // From I/O, setImmediate always beats setTimeout(0)
    setImmediate(() => {
      console.log(`[T${++transitionCounter}] CHECK beats timer from I/O`);
    });
    
    setTimeout(() => {
      console.log(`[T${++transitionCounter}] TIMER loses to immediate from I/O`);
    }, 0);
  });
  
}, 100);

// =============================================================================
// ADVANCED: Microtask Starvation
// =============================================================================
// Warning: Microtasks can starve the event loop!

setTimeout(() => {
  console.log('\n' + '='.repeat(70));
  console.log('MICROTASK STARVATION WARNING');
  console.log('='.repeat(70) + '\n');
  
  let count = 0;
  const maxCount = 5;
  
  function recursiveNextTick() {
    if (count++ < maxCount) {
      process.nextTick(() => {
        console.log(`Microtask ${count} - blocking phase transition!`);
        recursiveNextTick();
      });
    } else {
      console.log('Microtask queue finally empty, phases can continue');
    }
  }
  
  console.log('Starting recursive nextTicks...');
  recursiveNextTick();
  
  setImmediate(() => {
    console.log('This immediate had to wait for all microtasks!');
  });
  
}, 200);

// =============================================================================
// SUMMARY AND EXIT
// =============================================================================

setTimeout(() => {
  console.log('\n' + '='.repeat(70));
  console.log('EVENT LOOP PHASES SUMMARY');
  console.log('='.repeat(70));
  console.log(`
EXECUTION ORDER RULES:

1. Main module executes first (synchronous code)
2. Event loop begins, cycling through phases:
   
   ┌───────────────────────────┐
┌─>│         Timers            │  setTimeout/setInterval
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │     Pending Callbacks     │  Deferred I/O callbacks
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │       Idle, Prepare       │  Internal use only
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │           Poll            │  Fetch I/O, execute callbacks
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │           Check           │  setImmediate
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
└──┤      Close Callbacks      │  socket.on('close')
   └───────────────────────────┘

3. MICROTASKS run between EACH phase:
   - process.nextTick() (highest priority)
   - Promise.then/catch/finally
   - queueMicrotask()

KEY INSIGHTS:

• setTimeout(0) vs setImmediate:
  - From main: Order unpredictable
  - From I/O callback: setImmediate ALWAYS wins
  
• process.nextTick:
  - Not part of event loop phases
  - Runs after current operation, before next phase
  - Can starve the event loop if recursive
  
• Poll Phase:
  - Where the loop can block waiting for I/O
  - Will wait up to timer threshold
  - Most time is spent here in I/O-heavy apps

• Phase Transitions:
  - Each phase processes ALL callbacks in its queue
  - Or hits maximum callback limit (prevents starvation)
  - Then moves to next phase

Remember: Understanding phases helps predict execution order!
  `);
  
  process.exit(0);
}, 1000);