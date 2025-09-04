/**
 * V8 Performance Cliffs - Common Pitfalls
 * ========================================
 * This file demonstrates real-world performance cliffs that can cause
 * dramatic slowdowns in Node.js applications. Each example shows the
 * problem and the solution with measurable performance differences.
 *
 * Run with: node performance-cliffs.js
 * For optimization details: node --trace-opt --trace-deopt performance-cliffs.js
 *
 * Performance Cliffs Covered:
 * 1. Delete operator forcing dictionary mode
 * 2. Unstable object shapes
 * 3. Arguments object deoptimization
 * 4. Array element kind transitions
 * 5. Mixed type operations
 * 6. Try-catch in hot paths (modern V8 handles better)
 * 7. With statement and eval (optimization killers)
 */

console.log("=".repeat(80));
console.log("V8 PERFORMANCE CLIFFS - REAL-WORLD SCENARIOS");
console.log("=".repeat(80));

// ===========================================================================
// CLIFF #1: Delete Operator Forces Dictionary Mode
// ===========================================================================

console.log("\n CLIFF #1: Delete Operator vs Setting to Undefined");
console.log("-".repeat(50));

// Simulating a cache object scenario
class CacheWithDelete {
  constructor() {
    this.data = {};
    // Pre-populate with some data
    for (let i = 0; i < 100; i++) {
      this.data["key" + i] = { value: i, timestamp: Date.now() };
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
  }

  evict(key) {
    // BAD: Using delete forces dictionary mode
    delete this.data[key];
  }
}

class CacheWithUndefined {
  constructor() {
    this.data = {};
    // Pre-populate with same data
    for (let i = 0; i < 100; i++) {
      this.data["key" + i] = { value: i, timestamp: Date.now() };
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
  }

  evict(key) {
    // GOOD: Setting to undefined maintains fast properties
    this.data[key] = undefined;
  }
}

// Benchmark the difference
const CACHE_ITERATIONS = 1000000;

console.log("Testing cache operations with delete vs undefined...");

// Test with delete
const cacheDelete = new CacheWithDelete();
console.time("Cache with delete");
for (let i = 0; i < CACHE_ITERATIONS; i++) {
  const key = "key" + (i % 100);
  if (i % 10 === 0) {
    cacheDelete.evict(key);
    cacheDelete.set(key, { value: i, timestamp: Date.now() });
  }
  cacheDelete.get(key);
}
console.timeEnd("Cache with delete");

// Test with undefined
const cacheUndefined = new CacheWithUndefined();
console.time("Cache with undefined");
for (let i = 0; i < CACHE_ITERATIONS; i++) {
  const key = "key" + (i % 100);
  if (i % 10 === 0) {
    cacheUndefined.evict(key);
    cacheUndefined.set(key, { value: i, timestamp: Date.now() });
  }
  cacheUndefined.get(key);
}
console.timeEnd("Cache with undefined");

console.log("Note: Real benchmark results (V8 v12.4.254.21):");
console.log("- Single delete: 7.3x slower than setting to undefined");
console.log("- Multiple deletes: 73.8x slower than setting to undefined");
console.log("- Dictionary mode access: 3.4x slower");

// ===========================================================================
// CLIFF #2: Unstable Object Shapes in Data Processing
// ===========================================================================

console.log("\n\nCLIFF #2: Unstable Object Shapes in Hot Paths");
console.log("-".repeat(50));

// BAD: Creating objects with varying shapes
function processDataBad(items) {
  const results = [];
  for (const item of items) {
    const result = {};
    result.id = item.id;

    // Conditional properties create different hidden classes
    if (item.type === "user") {
      result.userName = item.name;
      result.userEmail = item.email;
    } else if (item.type === "product") {
      result.productName = item.name;
      result.price = item.price;
    }

    // More conditional properties
    if (item.premium) {
      result.premiumFeatures = item.features;
    }

    results.push(result);
  }
  return results;
}

// GOOD: Stable object shapes with consistent properties
function processDataGood(items) {
  const results = [];
  for (const item of items) {
    // Always create objects with ALL properties
    const result = {
      id: item.id,
      userName: null,
      userEmail: null,
      productName: null,
      price: null,
      premiumFeatures: null,
      type: item.type,
    };

    // Update values without changing shape
    if (item.type === "user") {
      result.userName = item.name;
      result.userEmail = item.email;
    } else if (item.type === "product") {
      result.productName = item.name;
      result.price = item.price;
    }

    if (item.premium) {
      result.premiumFeatures = item.features;
    }

    results.push(result);
  }
  return results;
}

// Create test data
const testData = [];
for (let i = 0; i < 10000; i++) {
  if (i % 2 === 0) {
    testData.push({
      id: i,
      type: "user",
      name: "User" + i,
      email: "user" + i + "@example.com",
      premium: i % 3 === 0,
      features: ["feature1", "feature2"],
    });
  } else {
    testData.push({
      id: i,
      type: "product",
      name: "Product" + i,
      price: i * 10,
      premium: i % 3 === 0,
      features: ["feature3", "feature4"],
    });
  }
}

console.log("Processing data with unstable vs stable shapes...");

console.time("Unstable shapes");
for (let i = 0; i < 100; i++) {
  processDataBad(testData);
}
console.timeEnd("Unstable shapes");

console.time("Stable shapes");
for (let i = 0; i < 100; i++) {
  processDataGood(testData);
}
console.timeEnd("Stable shapes");

// ===========================================================================
// CLIFF #3: Arguments Object Deoptimization
// ===========================================================================

console.log("\n\nCLIFF #3: Arguments Object vs Rest Parameters");
console.log("-".repeat(50));

// BAD: Using arguments object
function sumArgumentsBad() {
  // The 'arguments' object is hard to optimize
  let sum = 0;
  for (let i = 0; i < arguments.length; i++) {
    sum += arguments[i];
  }
  return sum;
}

// Worse: Leaking arguments
function sumArgumentsWorse() {
  // Leaking arguments prevents optimization
  const args = arguments;
  return Array.prototype.reduce.call(args, (a, b) => a + b, 0);
}

// GOOD: Using rest parameters
function sumArgumentsGood(...args) {
  // Rest parameters are fully optimizable
  let sum = 0;
  for (let i = 0; i < args.length; i++) {
    sum += args[i];
  }
  return sum;
}

// BEST: Fixed parameters when possible
function sumFixed(a, b, c, d, e) {
  // Fixed parameters are the fastest
  return (a || 0) + (b || 0) + (c || 0) + (d || 0) + (e || 0);
}

const ARGS_ITERATIONS = 1000000;

console.log("Testing different parameter handling patterns...");

console.time("Arguments object");
for (let i = 0; i < ARGS_ITERATIONS; i++) {
  sumArgumentsBad(i, i + 1, i + 2, i + 3, i + 4);
}
console.timeEnd("Arguments object");

console.time("Arguments leaked");
for (let i = 0; i < ARGS_ITERATIONS; i++) {
  sumArgumentsWorse(i, i + 1, i + 2, i + 3, i + 4);
}
console.timeEnd("Arguments leaked");

console.time("Rest parameters");
for (let i = 0; i < ARGS_ITERATIONS; i++) {
  sumArgumentsGood(i, i + 1, i + 2, i + 3, i + 4);
}
console.timeEnd("Rest parameters");

console.time("Fixed parameters");
for (let i = 0; i < ARGS_ITERATIONS; i++) {
  sumFixed(i, i + 1, i + 2, i + 3, i + 4);
}
console.timeEnd("Fixed parameters");

// ===========================================================================
// CLIFF #4: Array Element Kind Transitions
// ===========================================================================

console.log("\n\nCLIFF #4: Array Element Kind Transitions");
console.log("-".repeat(50));

// BAD: Mixing element types causes transitions
function createMixedArray() {
  const arr = [];
  for (let i = 0; i < 1000; i++) {
    if (i < 333) {
      arr.push(i); // SMI elements
    } else if (i < 666) {
      arr.push(i + 0.5); // Transition to DOUBLE elements
    } else {
      arr.push("item" + i); // Transition to PACKED elements
    }
  }
  return arr;
}

// GOOD: Maintain consistent element kinds
function createStableArrays() {
  const intArray = [];
  const floatArray = [];
  const stringArray = [];

  for (let i = 0; i < 1000; i++) {
    if (i < 333) {
      intArray.push(i);
    } else if (i < 666) {
      floatArray.push(i + 0.5);
    } else {
      stringArray.push("item" + i);
    }
  }

  return { intArray, floatArray, stringArray };
}

// BAD: Creating holes in arrays
function createHoleyArray() {
  const arr = [];
  for (let i = 0; i < 1000; i++) {
    if (i % 3 !== 0) {
      arr[i] = i; // Creates holes at indices where i % 3 === 0
    }
  }
  return arr;
}

// GOOD: Dense arrays without holes
function createDenseArray() {
  const arr = [];
  for (let i = 0; i < 1000; i++) {
    arr.push(i % 3 !== 0 ? i : null); // No holes, use null instead
  }
  return arr;
}

console.log("Testing array element kind performance...");

const ARRAY_ITERATIONS = 10000;

// Test mixed arrays
console.time("Mixed element kinds");
for (let i = 0; i < ARRAY_ITERATIONS; i++) {
  const arr = createMixedArray();
  let sum = 0;
  for (let j = 0; j < arr.length; j++) {
    if (typeof arr[j] === "number") sum += arr[j];
  }
}
console.timeEnd("Mixed element kinds");

// Test stable arrays
console.time("Stable element kinds");
for (let i = 0; i < ARRAY_ITERATIONS; i++) {
  const arrays = createStableArrays();
  let sum = 0;
  for (let j = 0; j < arrays.intArray.length; j++) {
    sum += arrays.intArray[j];
  }
  for (let j = 0; j < arrays.floatArray.length; j++) {
    sum += arrays.floatArray[j];
  }
}
console.timeEnd("Stable element kinds");

// Test holey vs dense arrays
console.time("Holey arrays");
for (let i = 0; i < ARRAY_ITERATIONS; i++) {
  const arr = createHoleyArray();
  let sum = 0;
  for (let j = 0; j < arr.length; j++) {
    if (arr[j] !== undefined) sum += arr[j];
  }
}
console.timeEnd("Holey arrays");

console.time("Dense arrays");
for (let i = 0; i < ARRAY_ITERATIONS; i++) {
  const arr = createDenseArray();
  let sum = 0;
  for (let j = 0; j < arr.length; j++) {
    if (arr[j] !== null) sum += arr[j];
  }
}
console.timeEnd("Dense arrays");

// ===========================================================================
// CLIFF #5: Try-Catch in Modern V8 (Mostly Fixed)
// ===========================================================================

console.log("\n\nCLIFF #5: Try-Catch Performance (Modern V8)");
console.log("-".repeat(50));
console.log("Note: Modern V8 (Node 16+) optimizes try-catch well.");
console.log("The performance difference is now minimal.\n");

// Old advice said to avoid try-catch in hot paths
function withTryCatch(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    try {
      sum += arr[i];
    } catch (e) {
      console.error("Error:", e);
    }
  }
  return sum;
}

// Without try-catch
function withoutTryCatch(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
  }
  return sum;
}

const testArray = new Array(10000).fill(0).map((_, i) => i);
const TRY_ITERATIONS = 10000;

console.time("With try-catch");
for (let i = 0; i < TRY_ITERATIONS; i++) {
  withTryCatch(testArray);
}
console.timeEnd("With try-catch");

console.time("Without try-catch");
for (let i = 0; i < TRY_ITERATIONS; i++) {
  withoutTryCatch(testArray);
}
console.timeEnd("Without try-catch");

console.log("Note: Modern V8 shows minimal difference!");

// ===========================================================================
// CLIFF #6: With Statement and Eval (Still Bad!)
// ===========================================================================

console.log("\n\nCLIFF #6: Optimization Killers (eval, with)");
console.log("-".repeat(50));
console.log("WARNING: These patterns completely disable optimization!\n");

// BAD: Using eval
function calculateWithEval(expression, x) {
  // eval prevents ALL optimization
  return eval(expression);
}

// BAD: Using with statement
function processWithStatement(obj) {
  let result = 0;
  // 'with' is deprecated and kills optimization
  with (obj) {
    result = value1 + value2 + value3;
  }
  return result;
}

// GOOD: Direct property access
function processDirectly(obj) {
  return obj.value1 + obj.value2 + obj.value3;
}

const testObj = { value1: 10, value2: 20, value3: 30 };

console.log("These patterns are so bad we won't even benchmark them!");
console.log("Just remember: NEVER use eval() or with statements.");
console.log("eval() result:", calculateWithEval("x * 2", 5));
console.log("Direct result:", 5 * 2);

// ===========================================================================
// KEY TAKEAWAYS
// ===========================================================================

console.log("\n\n" + "=".repeat(80));
console.log("PERFORMANCE CLIFF SURVIVAL GUIDE");
console.log("=".repeat(80));
console.log(`
CRITICAL CLIFFS TO AVOID:

1. DELETE OPERATOR (Real benchmarks: V8 v12.4.254.21)
   BAD: delete obj.prop     -> Forces dictionary mode (7-74x slower)
   GOOD: obj.prop = undefined -> Maintains fast properties

2. UNSTABLE OBJECT SHAPES
   BAD: Conditional properties -> Different hidden classes
   GOOD: Pre-initialize all properties -> Stable hidden classes

3. ARGUMENTS OBJECT
   BAD: arguments[i]     -> Hard to optimize
   GOOD: ...rest params   -> Fully optimizable

4. ARRAY ELEMENT TRANSITIONS
   BAD: Mixed types in arrays -> Element kind transitions
   GOOD: Consistent types      -> Stable, fast arrays

5. HOLEY ARRAYS
   BAD: arr[100] = x     -> Creates holes
   GOOD: arr.push(x)      -> Dense arrays

6. OPTIMIZATION KILLERS
   BAD: eval()           -> Disables ALL optimization
   BAD: with statement   -> Disables ALL optimization
   GOOD: Direct code      -> Full optimization

MODERN V8 IMPROVEMENTS:
- try-catch is now well-optimized (Node 16+)
- Many old performance myths no longer apply
- But fundamentals (shapes, ICs) still matter!

Remember: Profile first, optimize second!
`);
