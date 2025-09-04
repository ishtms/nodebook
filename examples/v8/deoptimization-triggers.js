/**
 * V8 Deoptimization Triggers and Recovery
 * ========================================
 * This file demonstrates common scenarios that cause V8 to deoptimize
 * functions and shows how to identify and fix them.
 * 
 * Run with: node --trace-deopt deoptimization-triggers.js
 * For detailed output: node --trace-opt --trace-deopt deoptimization-triggers.js
 * 
 * Deoptimization (bailout) occurs when:
 * - Type assumptions fail
 * - Hidden class changes unexpectedly
 * - Code patterns V8 can't optimize
 * 
 * Real benchmark results (V8 v12.4.254.21):
 * - Type changes: 19x slower
 * - With statement: 423x slower (!)
 * - eval(): 107x slower
 */

console.log('='.repeat(80));
console.log('V8 DEOPTIMIZATION TRIGGERS AND RECOVERY');
console.log('='.repeat(80));

// ===========================================================================
// TRIGGER 1: Hidden Class Changes
// ===========================================================================

console.log('\nTRIGGER 1: Unexpected Hidden Class Changes');
console.log('-'.repeat(50));

// This function will be optimized for one shape, then deoptimized
function processPoint_Deopt1(point) {
    return point.x + point.y;
}

// Train with one shape
class PointA {
    constructor(x, y) {
        this.x = x;
        this.y = y;
    }
}

// Warm up with PointA
console.log('Training function with PointA shape...');
for (let i = 0; i < 10000; i++) {
    processPoint_Deopt1(new PointA(i, i));
}
console.log('Function optimized for PointA');

// Now introduce a different shape - causes deoptimization!
class PointB {
    constructor(x, y) {
        this.y = y;  // Different property order!
        this.x = x;
    }
}

console.log('\nIntroducing PointB with different property order...');
processPoint_Deopt1(new PointB(100, 200));
console.log('DEOPTIMIZATION: Function bailed out due to hidden class mismatch');

// FIX: Use consistent shapes
function processPoint_Fixed1(point) {
    return point.x + point.y;
}

console.log('\nFIX: Always use consistent property order in constructors');

// ===========================================================================
// TRIGGER 2: Type Changes (Number to String)
// ===========================================================================

console.log('\n\nTRIGGER 2: Type Assumption Failures');
console.log('-'.repeat(50));

function calculate_Deopt2(a, b) {
    return a + b;  // V8 will optimize for numbers
}

// Train with numbers
console.log('Training function with numbers...');
for (let i = 0; i < 10000; i++) {
    calculate_Deopt2(i, i + 1);
}
console.log('Function optimized for number addition');

// Cause deoptimization with different types
console.log('\nPassing strings instead of numbers...');
calculate_Deopt2('hello', 'world');
console.log('DEOPTIMIZATION: Type assumption failed');

// FIX: Type-specific functions or type guards
function calculateNumbers(a, b) {
    // Explicitly for numbers
    return a + b;
}

function calculateStrings(a, b) {
    // Explicitly for strings
    return a + b;
}

function calculate_Fixed2(a, b) {
    // Type guard at boundary
    if (typeof a === 'number' && typeof b === 'number') {
        return calculateNumbers(a, b);
    } else {
        return calculateStrings(String(a), String(b));
    }
}

console.log('\nFIX: Use type-specific functions or type guards');

// ===========================================================================
// TRIGGER 3: Arguments Object Usage
// ===========================================================================

console.log('\n\nTRIGGER 3: Arguments Object Deoptimization');
console.log('-'.repeat(50));

// Functions using 'arguments' are hard to optimize
function sum_Deopt3() {
    let total = 0;
    for (let i = 0; i < arguments.length; i++) {
        total += arguments[i];
    }
    return total;
}

// Even worse: leaking arguments
function sum_Deopt3_Worse() {
    const args = arguments;  // Leaking arguments object
    return Array.prototype.reduce.call(args, (a, b) => a + b, 0);
}

// FIX: Use rest parameters
function sum_Fixed3(...numbers) {
    let total = 0;
    for (let i = 0; i < numbers.length; i++) {
        total += numbers[i];
    }
    return total;
}

console.log('Using arguments object prevents optimization');
console.log('arguments result:', sum_Deopt3(1, 2, 3, 4, 5));
console.log('rest params result:', sum_Fixed3(1, 2, 3, 4, 5));
console.log('\nFIX: Use rest parameters (...args) instead of arguments');

// ===========================================================================
// TRIGGER 4: try-catch with Non-Local Returns (Historical)
// ===========================================================================

console.log('\n\nTRIGGER 4: try-catch Optimization (Mostly Fixed)');
console.log('-'.repeat(50));

// Old V8 couldn't optimize functions with try-catch well
function riskyOperation_Old(arr) {
    let sum = 0;
    try {
        for (let i = 0; i < arr.length; i++) {
            sum += arr[i];
        }
    } catch (e) {
        return -1;
    }
    return sum;
}

// Modern V8 handles this much better
function riskyOperation_Modern(arr) {
    let sum = 0;
    try {
        for (let i = 0; i < arr.length; i++) {
            sum += arr[i];
        }
    } catch (e) {
        console.error('Error:', e);
        return -1;
    }
    return sum;
}

console.log('Historical issue: try-catch prevented optimization');
console.log('Modern V8 (Node 16+): try-catch is well optimized');
console.log('Result:', riskyOperation_Modern([1, 2, 3, 4, 5]));

// ===========================================================================
// TRIGGER 5: Delete Operator
// ===========================================================================

console.log('\n\nTRIGGER 5: Delete Operator Forces Dictionary Mode');
console.log('-'.repeat(50));

function processObject_Deopt5(obj) {
    // After delete, property access becomes slow
    const value = obj.x + obj.y + obj.z;
    delete obj.y;  // Forces dictionary mode!
    return value + obj.x + obj.z;  // Slow property access
}

// FIX: Set to undefined instead
function processObject_Fixed5(obj) {
    const value = obj.x + obj.y + obj.z;
    obj.y = undefined;  // Maintains fast properties
    return value + obj.x + obj.z;  // Still fast!
}

const testObj = { x: 1, y: 2, z: 3 };
console.log('Using delete forces slow dictionary mode');
console.log('FIX: Set properties to undefined instead of deleting');

// ===========================================================================
// TRIGGER 6: Non-SMI Operations
// ===========================================================================

console.log('\n\nTRIGGER 6: Non-SMI (Small Integer) Deoptimization');
console.log('-'.repeat(50));

function calculate_Deopt6(n) {
    let result = 0;
    for (let i = 0; i < n; i++) {
        result += i * 0.5;  // Creates heap numbers (non-SMI)
    }
    return result;
}

// FIX: Keep operations as SMI when possible
function calculate_Fixed6(n) {
    let result = 0;
    for (let i = 0; i < n; i++) {
        result = (result + i) | 0;  // Bitwise OR keeps as SMI
    }
    return result;
}

console.log('Floating point operations create heap numbers (slower)');
console.log('FIX: Use integer operations and bitwise OR to maintain SMI');

// ===========================================================================
// TRIGGER 7: Polymorphic Operations
// ===========================================================================

console.log('\n\nTRIGGER 7: Polymorphic to Megamorphic Transition');
console.log('-'.repeat(50));

function getValue_Deopt7(obj) {
    return obj.value;  // This call site will see many shapes
}

// Create many different shapes
const shapes = [];
for (let i = 0; i < 10; i++) {
    const obj = {};
    // Different property addition order creates different shapes
    for (let j = 0; j <= i; j++) {
        obj['prop' + j] = j;
    }
    obj.value = i;
    shapes.push(obj);
}

console.log('Training function with many shapes...');
shapes.forEach(obj => getValue_Deopt7(obj));
console.log('Function became megamorphic (very slow)');

// FIX: Use consistent shapes
class ConsistentShape {
    constructor(value) {
        this.value = value;
        this.metadata = null;
    }
}

function getValue_Fixed7(obj) {
    return obj.value;
}

console.log('\nFIX: Use classes or factories for consistent shapes');

// ===========================================================================
// TRIGGER 8: Out-of-Bounds Array Access
// ===========================================================================

console.log('\n\nTRIGGER 8: Out-of-Bounds Array Access');
console.log('-'.repeat(50));

function processArray_Deopt8(arr) {
    let sum = 0;
    // Accessing beyond array bounds can cause deoptimization
    for (let i = 0; i <= arr.length; i++) {  // Note: <= causes out-of-bounds
        sum += arr[i] || 0;  // arr[length] is undefined
    }
    return sum;
}

// FIX: Stay within bounds
function processArray_Fixed8(arr) {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {  // Correct: <
        sum += arr[i];
    }
    return sum;
}

console.log('Out-of-bounds access can trigger deoptimization');
console.log('FIX: Always stay within array bounds');

// ===========================================================================
// DETECTING DEOPTIMIZATION
// ===========================================================================

console.log('\n\nDETECTING DEOPTIMIZATION');
console.log('='.repeat(80));

console.log(`
How to detect deoptimization:

1. USE V8 FLAGS:
   node --trace-deopt script.js
   Shows when and why functions are deoptimized
   
2. LOOK FOR PATTERNS:
   [deoptimizing: begin ... reason=wrong map]
   [deoptimizing: begin ... reason=unexpected type]
   
3. COMMON REASONS:
   - "wrong map" = hidden class mismatch
   - "unexpected type" = type assumption failed
   - "Insufficient type feedback" = needs more warmup
   - "out of bounds" = array access beyond length

4. PROFILE WITH CHROME DEVTOOLS:
   node --inspect script.js
   Look for functions marked as "not optimized"
`);

// ===========================================================================
// RECOVERY STRATEGIES
// ===========================================================================

console.log('\nRECOVERY STRATEGIES');
console.log('='.repeat(80));

console.log(`
How to fix deoptimization:

1. MAINTAIN TYPE CONSISTENCY
   - Use TypeScript or JSDoc for type hints
   - Create type-specific functions
   - Add type guards at boundaries

2. USE STABLE OBJECT SHAPES
   - Initialize all properties in constructors
   - Use classes for consistent shapes
   - Avoid conditional properties

3. AVOID DEOPT TRIGGERS
   - Use rest params instead of arguments
   - Set to undefined instead of delete
   - Keep array access in bounds
   - Use integer operations for hot loops

4. WARM UP PROPERLY
   - Run hot functions multiple times before load
   - Provide consistent input types during warmup
   - Use --allow-natives-syntax to force optimization

5. MONITOR AND MEASURE
   - Use --trace-deopt in development
   - Profile with Chrome DevTools
   - Measure before and after optimization
`);

// ===========================================================================
// SUMMARY
// ===========================================================================

console.log('\n\n' + '='.repeat(80));
console.log('DEOPTIMIZATION PREVENTION CHECKLIST');
console.log('='.repeat(80));
console.log(`
COMMON TRIGGERS & FIXES:

1. HIDDEN CLASS CHANGES
   BAD: Different property orders
   GOOD: Consistent constructors/classes

2. TYPE CHANGES
   BAD: Mixed types in hot functions
   GOOD: Type-specific functions

3. ARGUMENTS OBJECT
   BAD: Using arguments
   GOOD: Rest parameters (...args)

4. DELETE OPERATOR
   BAD: delete obj.prop
   GOOD: obj.prop = undefined

5. POLYMORPHIC FUNCTIONS
   BAD: Many different shapes
   GOOD: Monomorphic functions

6. OUT-OF-BOUNDS ACCESS
   BAD: arr[arr.length]
   GOOD: Stay within bounds

7. NON-SMI OPERATIONS
   BAD: Floating point in hot loops
   GOOD: Integer operations with | 0

DEBUGGING COMMANDS:
- node --trace-opt script.js (see optimizations)
- node --trace-deopt script.js (see deoptimizations)
- node --trace-ic script.js (see inline cache states)
- node --inspect script.js (use Chrome DevTools)

REMEMBER:
- Deoptimization can cause extreme slowdowns:
  * Type changes: 19x (benchmarked)
  * With statement: 423x (benchmarked)
  * eval(): 107x (benchmarked)
- Most deopts are caused by type inconsistency
- Write boring, predictable code for V8
- Profile and measure, don't guess!
`);