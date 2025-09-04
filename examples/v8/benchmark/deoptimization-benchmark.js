/**
 * Deoptimization Triggers Performance Benchmark
 * Testing the mentioned numbers: Deoptimization can cause 10-100x performance degradation
 */

const { BenchmarkRunner, forceDeoptimization } = require("./benchmark-utils");

console.log("=".repeat(60));
console.log("DEOPTIMIZATION TRIGGERS BENCHMARK");
console.log("Testing performance impact of common deoptimization patterns");
console.log("=".repeat(60));

async function runBenchmarks() {
  console.log("\n1. TYPE FEEDBACK CHANGES\n");

  // Stable types (optimized)
  const stableTypesTest = new BenchmarkRunner("Stable Types", {
    iterations: 100000,
    samples: 10,
  });

  function processStable(x) {
    return x * 2 + 10;
  }

  // Warm up with consistent types
  for (let i = 0; i < 10000; i++) {
    processStable(i);
  }

  const stableResult = await stableTypesTest.run(() => {
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      sum += processStable(i);
    }
  });

  // Changing types (deoptimized)
  const changingTypesTest = new BenchmarkRunner("Changing Types", {
    iterations: 100000,
    samples: 10,
  });

  function processChanging(x) {
    return x * 2 + 10;
  }

  // Force multiple type changes
  let typeCounter = 0;

  const changingResult = await changingTypesTest.run(() => {
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      if (typeCounter++ % 20 === 0) {
        // Occasionally pass different types
        processChanging("42");
        processChanging([1, 2]);
        processChanging({ value: 5 });
      }
      sum += processChanging(i);
    }
  });

  console.log("Stable Types:" + BenchmarkRunner.formatResults(stableResult));
  console.log("\nChanging Types:" + BenchmarkRunner.formatResults(changingResult));

  const typeComparison = BenchmarkRunner.compare(stableResult, changingResult);
  console.log(`\nResult: Changing types cause ${typeComparison.summary}`);

  // Test 2: Hidden Class Changes
  console.log("\n" + "-".repeat(50));
  console.log("\n2. HIDDEN CLASS INSTABILITY\n");

  // Stable hidden classes
  const stableClassTest = new BenchmarkRunner("Stable Classes", {
    iterations: 50000,
    samples: 10,
  });

  class StablePoint {
    constructor(x, y) {
      this.x = x;
      this.y = y;
    }

    distance() {
      return Math.sqrt(this.x * this.x + this.y * this.y);
    }
  }

  const stableClassResult = await stableClassTest.run(() => {
    const points = [];
    for (let i = 0; i < 10; i++) {
      points.push(new StablePoint(i, i * 2));
    }
    let sum = 0;
    for (const p of points) {
      sum += p.distance();
    }
  });

  // Unstable hidden classes
  const unstableClassTest = new BenchmarkRunner("Unstable Classes", {
    iterations: 50000,
    samples: 10,
  });

  let shapeCounter = 0;

  const unstableClassResult = await unstableClassTest.run(() => {
    const points = [];
    for (let i = 0; i < 10; i++) {
      const p = {};
      if (shapeCounter++ % 3 === 0) {
        p.x = i;
        p.y = i * 2;
      } else if (shapeCounter % 3 === 1) {
        p.y = i * 2;
        p.x = i;
      } else {
        p.x = i;
        p.y = i * 2;
        p.z = i * 3; // Extra property
      }
      p.distance = function () {
        return Math.sqrt(this.x * this.x + this.y * this.y);
      };
      points.push(p);
    }
    let sum = 0;
    for (const p of points) {
      sum += p.distance();
    }
  });

  console.log("Stable Classes:" + BenchmarkRunner.formatResults(stableClassResult));
  console.log("\nUnstable Classes:" + BenchmarkRunner.formatResults(unstableClassResult));

  const classComparison = BenchmarkRunner.compare(stableClassResult, unstableClassResult);
  console.log(`\nResult: Unstable classes cause ${classComparison.summary}`);

  // Test 3: Try-Catch Deoptimization
  console.log("\n" + "-".repeat(50));
  console.log("\n3. TRY-CATCH IMPACT\n");

  // No try-catch
  const noTryTest = new BenchmarkRunner("No Try-Catch", {
    iterations: 100000,
    samples: 10,
  });

  function computeNoTry(x, y) {
    return x * y + x / y - Math.sqrt(x * x + y * y);
  }

  const noTryResult = await noTryTest.run(() => {
    let sum = 0;
    for (let i = 1; i <= 50; i++) {
      sum += computeNoTry(i, i + 1);
    }
  });

  // With try-catch
  const withTryTest = new BenchmarkRunner("With Try-Catch", {
    iterations: 100000,
    samples: 10,
  });

  function computeWithTry(x, y) {
    try {
      return x * y + x / y - Math.sqrt(x * x + y * y);
    } catch (e) {
      return 0;
    }
  }

  const withTryResult = await withTryTest.run(() => {
    let sum = 0;
    for (let i = 1; i <= 50; i++) {
      sum += computeWithTry(i, i + 1);
    }
  });

  console.log("No Try-Catch:" + BenchmarkRunner.formatResults(noTryResult));
  console.log("\nWith Try-Catch:" + BenchmarkRunner.formatResults(withTryResult));

  const tryComparison = BenchmarkRunner.compare(noTryResult, withTryResult);
  console.log(`\nResult: Try-catch causes ${tryComparison.summary}`);

  // Test 4: Arguments Object Usage
  console.log("\n" + "-".repeat(50));
  console.log("\n4. ARGUMENTS OBJECT IMPACT\n");

  // Rest parameters (optimized)
  const restParamsTest = new BenchmarkRunner("Rest Parameters", {
    iterations: 100000,
    samples: 10,
  });

  function sumRest(...args) {
    let sum = 0;
    for (const val of args) {
      sum += val;
    }
    return sum;
  }

  const restResult = await restParamsTest.run(() => {
    let total = 0;
    for (let i = 0; i < 10; i++) {
      total += sumRest(i, i + 1, i + 2, i + 3, i + 4);
    }
  });

  // Arguments object (potentially deoptimized)
  const argumentsTest = new BenchmarkRunner("Arguments Object", {
    iterations: 100000,
    samples: 10,
  });

  function sumArguments() {
    let sum = 0;
    for (let i = 0; i < arguments.length; i++) {
      sum += arguments[i];
    }
    return sum;
  }

  const argumentsResult = await argumentsTest.run(() => {
    let total = 0;
    for (let i = 0; i < 10; i++) {
      total += sumArguments(i, i + 1, i + 2, i + 3, i + 4);
    }
  });

  console.log("Rest Parameters:" + BenchmarkRunner.formatResults(restResult));
  console.log("\nArguments Object:" + BenchmarkRunner.formatResults(argumentsResult));

  const argsComparison = BenchmarkRunner.compare(restResult, argumentsResult);
  console.log(`\nResult: Arguments object causes ${argsComparison.summary}`);

  // Test 5: With Statement (severe deopt)
  console.log("\n" + "-".repeat(50));
  console.log("\n5. WITH STATEMENT IMPACT\n");

  // Normal property access
  const normalAccessTest = new BenchmarkRunner("Normal Access", {
    iterations: 100000,
    samples: 10,
  });

  const config = {
    multiplier: 2,
    offset: 10,
    scale: 0.5,
  };

  const normalResult = await normalAccessTest.run(() => {
    let sum = 0;
    for (let i = 0; i < 20; i++) {
      sum += i * config.multiplier + config.offset * config.scale;
    }
  });

  // With statement (deoptimized)
  const withStatementTest = new BenchmarkRunner("With Statement", {
    iterations: 100000,
    samples: 10,
  });

  const withResult = await withStatementTest.run(() => {
    let sum = 0;
    with (config) {
      for (let i = 0; i < 20; i++) {
        sum += i * multiplier + offset * scale;
      }
    }
  });

  console.log("Normal Access:" + BenchmarkRunner.formatResults(normalResult));
  console.log("\nWith Statement:" + BenchmarkRunner.formatResults(withResult));

  const withComparison = BenchmarkRunner.compare(normalResult, withResult);
  console.log(`\nResult: With statement causes ${withComparison.summary}`);

  // Test 6: eval() Impact
  console.log("\n" + "-".repeat(50));
  console.log("\n6. EVAL IMPACT\n");

  // Direct computation
  const directTest = new BenchmarkRunner("Direct Computation", {
    iterations: 10000,
    samples: 10,
  });

  const directResult = await directTest.run(() => {
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      sum += i * 2 + 5;
    }
  });

  // Using eval (severe deopt)
  const evalTest = new BenchmarkRunner("Using eval()", {
    iterations: 10000,
    samples: 10,
  });

  const evalResult = await evalTest.run(() => {
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      sum += eval("i * 2 + 5");
    }
  });

  console.log("Direct:" + BenchmarkRunner.formatResults(directResult));
  console.log("\neval():" + BenchmarkRunner.formatResults(evalResult));

  const evalComparison = BenchmarkRunner.compare(directResult, evalResult);
  console.log(`\nResult: eval() causes ${evalComparison.summary}`);

  // Test 7: Forced Deoptimization Pattern
  console.log("\n" + "-".repeat(50));
  console.log("\n7. FORCED DEOPTIMIZATION PATTERN\n");

  // Optimized function
  const optimizedTest = new BenchmarkRunner("Optimized Function", {
    iterations: 50000,
    samples: 10,
  });

  function optimizedCalc(x) {
    return x * x + x * 2 + 1;
  }

  // Warm up for optimization
  for (let i = 0; i < 10000; i++) {
    optimizedCalc(i);
  }

  const optimizedResult = await optimizedTest.run(() => {
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      sum += optimizedCalc(i);
    }
  });

  // Deoptimized function
  const deoptimizedTest = new BenchmarkRunner("Deoptimized Function", {
    iterations: 50000,
    samples: 10,
  });

  function deoptCalc(x) {
    return x * x + x * 2 + 1;
  }

  // Warm up with numbers
  for (let i = 0; i < 5000; i++) {
    deoptCalc(i);
  }

  // Force deoptimization
  forceDeoptimization(deoptCalc);

  const deoptResult = await deoptimizedTest.run(() => {
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      sum += deoptCalc(i);
    }
  });

  console.log("Optimized:" + BenchmarkRunner.formatResults(optimizedResult));
  console.log("\nDeoptimized:" + BenchmarkRunner.formatResults(deoptResult));

  const deoptComparison = BenchmarkRunner.compare(optimizedResult, deoptResult);
  console.log(`\nResult: Forced deoptimization causes ${deoptComparison.summary}`);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("BENCHMARK SUMMARY");
  console.log("=".repeat(60));
  console.log("Deoptimization Impact:");
  console.log(`  Type Changes: ${typeComparison.summary}`);
  console.log(`  Hidden Classes: ${classComparison.summary}`);
  console.log(`  Try-Catch: ${tryComparison.summary}`);
  console.log(`  Arguments: ${argsComparison.summary}`);
  console.log(`  With Statement: ${withComparison.summary}`);
  console.log(`  eval(): ${evalComparison.summary}`);
  console.log(`  Forced Deopt: ${deoptComparison.summary}`);

  // Check 10-100x claim
  const worstCase = Math.max(
    parseFloat(typeComparison.ratio),
    parseFloat(classComparison.ratio),
    parseFloat(withComparison.ratio),
    parseFloat(evalComparison.ratio),
    parseFloat(deoptComparison.ratio),
  );

  console.log(`\nWorst case: ${worstCase.toFixed(2)}x slower`);
  console.log(`10-100x claim: ${worstCase >= 10 ? "PARTIALLY CONFIRMED" : "NOT REPRODUCED"}`);

  return {
    typeChanges: typeComparison.ratio,
    hiddenClasses: classComparison.ratio,
    tryCatch: tryComparison.ratio,
    arguments: argsComparison.ratio,
    withStatement: withComparison.ratio,
    eval: evalComparison.ratio,
    forcedDeopt: deoptComparison.ratio,
    worstCase: worstCase.toFixed(2),
  };
}

module.exports = { runBenchmarks };

if (require.main === module) {
  runBenchmarks().catch(console.error);
}
