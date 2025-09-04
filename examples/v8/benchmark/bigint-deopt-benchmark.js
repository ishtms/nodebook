/**
 * BigInt Deoptimization Performance Benchmark
 * - Mixing BigInt and Number causes 10-100x performance degradation
 * - Polymorphic functions are 2-3x slower than monomorphic
 */

const { BenchmarkRunner } = require("./benchmark-utils");

console.log("=".repeat(60));
console.log("BIGINT DEOPTIMIZATION BENCHMARK");
console.log("Testing type mixing and deoptimization impact");
console.log("=".repeat(60));

async function runBenchmarks() {
  console.log("\n1. NUMBER VS BIGINT ARITHMETIC\n");

  // Pure Number arithmetic
  const numberTest = new BenchmarkRunner("Pure Numbers", {
    iterations: 1000000,
    samples: 10,
  });

  const numberResult = await numberTest.run(() => {
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      sum += i * 2;
    }
    return sum;
  });

  // Pure BigInt arithmetic
  const bigintTest = new BenchmarkRunner("Pure BigInt", {
    iterations: 1000000,
    samples: 10,
  });

  const bigintResult = await bigintTest.run(() => {
    let sum = 0n;
    for (let i = 0n; i < 100n; i++) {
      sum += i * 2n;
    }
    return sum;
  });

  // Mixed types (worst case)
  const mixedTest = new BenchmarkRunner("Mixed Types", {
    iterations: 1000000,
    samples: 10,
  });

  const mixedTypeResult = await mixedTest.run(() => {
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      if (i % 2 === 0) {
        sum = Number(BigInt(sum) + BigInt(i) * 2n);
      } else {
        sum = sum + i * 2;
      }
    }
    return sum;
  });

  console.log("Pure Numbers:" + BenchmarkRunner.formatResults(numberResult));
  console.log("\nPure BigInt:" + BenchmarkRunner.formatResults(bigintResult));
  console.log("\nMixed Types:" + BenchmarkRunner.formatResults(mixedTypeResult));

  const bigintComparison = BenchmarkRunner.compare(numberResult, bigintResult);
  const mixedComparison = BenchmarkRunner.compare(numberResult, mixedTypeResult);

  console.log("\n" + "-".repeat(50));
  console.log("RELATIVE PERFORMANCE:");
  console.log(`BigInt vs Number: ${bigintComparison.summary}`);
  console.log(`Mixed vs Number: ${mixedComparison.summary}`);

  // Test 2: Monomorphic vs Polymorphic Functions
  console.log("\n" + "-".repeat(50));
  console.log("\n2. MONOMORPHIC VS POLYMORPHIC FUNCTIONS\n");

  // Monomorphic function (numbers only)
  function processNumberMono(value) {
    return value * 2 + 10;
  }

  const monoFuncTest = new BenchmarkRunner("Monomorphic Function", {
    iterations: 1000000,
    samples: 10,
  });

  const monoFuncResult = await monoFuncTest.run(() => {
    let result = 0;
    for (let i = 0; i < 10; i++) {
      result += processNumberMono(i);
    }
  });

  // Polymorphic function (handles both types)
  function processPolymorphic(value) {
    if (typeof value === "bigint") {
      return value * 2n + 10n;
    } else {
      return value * 2 + 10;
    }
  }

  const polyFuncTest = new BenchmarkRunner("Polymorphic Function", {
    iterations: 1000000,
    samples: 10,
  });

  const polyFuncResult = await polyFuncTest.run(() => {
    let result = 0;
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) {
        result += Number(processPolymorphic(BigInt(i)));
      } else {
        result += processPolymorphic(i);
      }
    }
  });

  console.log("Monomorphic:" + BenchmarkRunner.formatResults(monoFuncResult));
  console.log("\nPolymorphic:" + BenchmarkRunner.formatResults(polyFuncResult));

  const funcComparison = BenchmarkRunner.compare(monoFuncResult, polyFuncResult);
  console.log(`\nResult: Polymorphic function is ${funcComparison.summary}`);

  // Test 3: Deoptimization Loop Pattern
  console.log("\n" + "-".repeat(50));
  console.log("\n3. DEOPTIMIZATION LOOP PATTERN\n");

  // Stable type function
  const stableTypeTest = new BenchmarkRunner("Stable Types", {
    iterations: 100000,
    samples: 10,
  });

  function calculateStable(a, b) {
    return a + b;
  }

  const stableResult = await stableTypeTest.run(() => {
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      sum = calculateStable(sum, i);
    }
  });

  // Type-changing function (causes deopt)
  const deoptTest = new BenchmarkRunner("Type Changes (Deopt)", {
    iterations: 100000,
    samples: 10,
  });

  function calculateUnstable(a, b) {
    return a + b;
  }

  const deoptResult = await deoptTest.run(() => {
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      if (i === 50) {
        // Force deoptimization midway
        sum = BigInt(sum);
        sum = calculateUnstable(sum, BigInt(i));
        sum = Number(sum);
      } else {
        sum = calculateUnstable(sum, i);
      }
    }
  });

  console.log("Stable Types:" + BenchmarkRunner.formatResults(stableResult));
  console.log("\nType Changes:" + BenchmarkRunner.formatResults(deoptResult));

  const deoptComparison = BenchmarkRunner.compare(stableResult, deoptResult);
  console.log(`\nResult: Type changes cause ${deoptComparison.summary}`);

  // Test 4: Dispatcher Pattern (Recommended Solution)
  console.log("\n" + "-".repeat(50));
  console.log("\n4. DISPATCHER PATTERN COMPARISON\n");

  // Bad: Generic handler
  const genericTest = new BenchmarkRunner("Generic Handler", {
    iterations: 100000,
    samples: 10,
  });

  function genericHandler(a, b) {
    if (typeof a === "bigint" && typeof b === "bigint") {
      return a + b;
    } else if (typeof a === "number" && typeof b === "number") {
      return a + b;
    } else {
      // Type conversion
      return Number(BigInt(a) + BigInt(b));
    }
  }

  let genericCounter = 0;
  const genericResult = await genericTest.run(() => {
    let sum = 0;
    for (let i = 0; i < 50; i++) {
      if (genericCounter++ % 3 === 0) {
        sum = Number(genericHandler(BigInt(sum), BigInt(i)));
      } else {
        sum = genericHandler(sum, i);
      }
    }
  });

  // Good: Dispatcher pattern
  const dispatcherTest = new BenchmarkRunner("Dispatcher Pattern", {
    iterations: 100000,
    samples: 10,
  });

  function handleNumber(a, b) {
    return a + b;
  }

  function handleBigInt(a, b) {
    return a + b;
  }

  function dispatcher(a, b) {
    if (typeof a === "bigint") {
      return handleBigInt(a, b);
    } else {
      return handleNumber(a, b);
    }
  }

  let dispatcherCounter = 0;
  const dispatcherResult = await dispatcherTest.run(() => {
    let sum = 0;
    for (let i = 0; i < 50; i++) {
      if (dispatcherCounter++ % 3 === 0) {
        const bigSum = BigInt(sum);
        const bigI = BigInt(i);
        sum = Number(dispatcher(bigSum, bigI));
      } else {
        sum = dispatcher(sum, i);
      }
    }
  });

  console.log("Generic Handler:" + BenchmarkRunner.formatResults(genericResult));
  console.log("\nDispatcher Pattern:" + BenchmarkRunner.formatResults(dispatcherResult));

  const dispatchComparison = BenchmarkRunner.compare(dispatcherResult, genericResult);
  console.log(`\nResult: Dispatcher pattern is ${dispatchComparison.summary}`);

  // Test 5: Real-world Scenario - ID Processing
  console.log("\n" + "-".repeat(50));
  console.log("\n5. REAL-WORLD SCENARIO: ID PROCESSING\n");

  // Consistent type approach
  const consistentIdTest = new BenchmarkRunner("Consistent IDs", {
    iterations: 50000,
    samples: 10,
  });

  class ConsistentIdProcessor {
    constructor() {
      this.cache = new Map();
    }

    processId(id) {
      // Always use strings for consistency
      const strId = String(id);

      if (this.cache.has(strId)) {
        return this.cache.get(strId);
      }

      const processed = {
        original: strId,
        hash: this.hashId(strId),
        timestamp: Date.now(),
      };

      this.cache.set(strId, processed);
      return processed;
    }

    hashId(id) {
      let hash = 0;
      for (let i = 0; i < id.length; i++) {
        hash = (hash << 5) - hash + id.charCodeAt(i);
        hash = hash & hash;
      }
      return hash;
    }
  }

  const consistentProcessor = new ConsistentIdProcessor();
  const testIds = [123, 456, 789, 234, 567, 890, 345, 678, 901, 234];

  const consistentResult = await consistentIdTest.run(() => {
    for (const id of testIds) {
      consistentProcessor.processId(id);
    }
  });

  // Mixed type approach (problematic)
  const mixedIdTest = new BenchmarkRunner("Mixed Type IDs", {
    iterations: 50000,
    samples: 10,
  });

  class MixedIdProcessor {
    constructor() {
      this.cache = new Map();
    }

    processId(id) {
      // Accepts both Number and BigInt
      if (this.cache.has(id)) {
        return this.cache.get(id);
      }

      const processed = {
        original: id,
        hash: this.hashId(id),
        timestamp: Date.now(),
      };

      this.cache.set(id, processed);
      return processed;
    }

    hashId(id) {
      if (typeof id === "bigint") {
        // BigInt path
        let hash = 0n;
        const str = id.toString();
        for (let i = 0; i < str.length; i++) {
          hash = (hash << 5n) - hash + BigInt(str.charCodeAt(i));
        }
        return Number(hash & 0xffffffffn);
      } else {
        // Number path
        let hash = 0;
        const str = String(id);
        for (let i = 0; i < str.length; i++) {
          hash = (hash << 5) - hash + str.charCodeAt(i);
          hash = hash & hash;
        }
        return hash;
      }
    }
  }

  const mixedProcessor = new MixedIdProcessor();
  const mixedIds = [123, 456n, 789, 234n, 567, 890n, 345, 678n, 901, 234n];

  const mixedResult = await mixedIdTest.run(() => {
    for (const id of mixedIds) {
      mixedProcessor.processId(id);
    }
  });

  console.log("Consistent Types:" + BenchmarkRunner.formatResults(consistentResult));
  console.log("\nMixed Types:" + BenchmarkRunner.formatResults(mixedResult));

  const realWorldComparison = BenchmarkRunner.compare(consistentResult, mixedResult);
  console.log(`\nResult: Mixed types are ${realWorldComparison.summary}`);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("BENCHMARK SUMMARY");
  console.log("=".repeat(60));
  console.log(`BigInt vs Number: ${bigintComparison.summary}`);
  console.log(`Mixed Types Impact: ${mixedComparison.summary}`);
  console.log(`Polymorphic Function: ${funcComparison.summary}`);
  console.log(`Deoptimization Impact: ${deoptComparison.summary}`);
  console.log(`Dispatcher Benefit: ${dispatchComparison.summary}`);
  console.log(`Real-world Impact: ${realWorldComparison.summary}`);

  const worstCase = Math.max(parseFloat(mixedComparison.ratio), parseFloat(deoptComparison.ratio), parseFloat(realWorldComparison.ratio));

  console.log(`\nWorst case: ${worstCase.toFixed(2)}x slower`);
  console.log(`10-100x claim: ${worstCase >= 10 ? "PARTIALLY CONFIRMED" : "NOT REPRODUCED"}`);

  return {
    bigintVsNumber: bigintComparison.ratio,
    mixedTypes: mixedComparison.ratio,
    polymorphic: funcComparison.ratio,
    deoptimization: deoptComparison.ratio,
    dispatcher: dispatchComparison.ratio,
    realWorld: realWorldComparison.ratio,
    worstCase: worstCase.toFixed(2),
  };
}

module.exports = { runBenchmarks };

if (require.main === module) {
  runBenchmarks().catch(console.error);
}
