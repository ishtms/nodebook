/**
 * Delete vs Undefined Performance Benchmark
 * - Setting to undefined is 30-70% faster than delete
 * - Delete forces dictionary mode (3-5x slower)
 */

const { BenchmarkRunner } = require("./benchmark-utils");

console.log("=".repeat(60));
console.log("DELETE VS UNDEFINED PERFORMANCE BENCHMARK");
console.log("Testing property removal strategies");
console.log("=".repeat(60));

async function runBenchmarks() {
  console.log("\n1. SINGLE PROPERTY REMOVAL\n");

  // Test: delete operator
  const deleteTest = new BenchmarkRunner("Delete Operator", {
    iterations: 100000,
    samples: 10,
  });

  const deleteResult = await deleteTest.run(() => {
    const obj = {
      id: 1,
      name: "test",
      value: 100,
      status: "active",
      timestamp: Date.now(),
    };
    delete obj.status;
    let sum = obj.id + obj.value;
  });

  // Test: set to undefined
  const undefinedTest = new BenchmarkRunner("Set to Undefined", {
    iterations: 100000,
    samples: 10,
  });

  const undefinedResult = await undefinedTest.run(() => {
    const obj = {
      id: 1,
      name: "test",
      value: 100,
      status: "active",
      timestamp: Date.now(),
    };
    obj.status = undefined;
    let sum = obj.id + obj.value;
  });

  // Test: set to null
  const nullTest = new BenchmarkRunner("Set to Null", {
    iterations: 100000,
    samples: 10,
  });

  const nullResult = await nullTest.run(() => {
    const obj = {
      id: 1,
      name: "test",
      value: 100,
      status: "active",
      timestamp: Date.now(),
    };
    obj.status = null;
    let sum = obj.id + obj.value;
  });

  console.log("Delete:" + BenchmarkRunner.formatResults(deleteResult));
  console.log("\nUndefined:" + BenchmarkRunner.formatResults(undefinedResult));
  console.log("\nNull:" + BenchmarkRunner.formatResults(nullResult));

  const deleteComparison = BenchmarkRunner.compare(undefinedResult, deleteResult);
  const nullComparison = BenchmarkRunner.compare(undefinedResult, nullResult);

  console.log("\n" + "-".repeat(50));
  console.log("RELATIVE PERFORMANCE:");
  console.log(`Delete vs Undefined: delete is ${deleteComparison.summary}`);
  console.log(`Null vs Undefined: null is ${nullComparison.summary}`);

  // Test 2: Multiple Property Removals
  console.log("\n" + "-".repeat(50));
  console.log("\n2. MULTIPLE PROPERTY REMOVALS\n");

  // Delete multiple properties
  const multiDeleteTest = new BenchmarkRunner("Multiple Deletes", {
    iterations: 50000,
    samples: 10,
  });

  const multiDeleteResult = await multiDeleteTest.run(() => {
    const obj = {
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      g: 7,
      h: 8,
      i: 9,
      j: 10,
    };
    delete obj.c;
    delete obj.g;
    delete obj.i;
    let sum = obj.a + obj.b + obj.d + obj.e;
  });

  // Set multiple to undefined
  const multiUndefinedTest = new BenchmarkRunner("Multiple Undefined", {
    iterations: 50000,
    samples: 10,
  });

  const multiUndefinedResult = await multiUndefinedTest.run(() => {
    const obj = {
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      g: 7,
      h: 8,
      i: 9,
      j: 10,
    };
    obj.c = undefined;
    obj.g = undefined;
    obj.i = undefined;
    let sum = obj.a + obj.b + obj.d + obj.e;
  });

  console.log("Multiple Deletes:" + BenchmarkRunner.formatResults(multiDeleteResult));
  console.log("\nMultiple Undefined:" + BenchmarkRunner.formatResults(multiUndefinedResult));

  const multiComparison = BenchmarkRunner.compare(multiUndefinedResult, multiDeleteResult);
  console.log(`\nResult: Multiple deletes are ${multiComparison.summary}`);

  // Test 3: Property Access After Removal (Dictionary Mode Impact)
  console.log("\n" + "-".repeat(50));
  console.log("\n3. POST-REMOVAL ACCESS PERFORMANCE\n");

  // Create objects with deleted properties (dictionary mode)
  const dictObjects = [];
  for (let i = 0; i < 100; i++) {
    const obj = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    delete obj.c;
    dictObjects.push(obj);
  }

  // Create objects with undefined properties (fast mode)
  const fastObjects = [];
  for (let i = 0; i < 100; i++) {
    const obj = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    obj.c = undefined;
    fastObjects.push(obj);
  }

  // Test dictionary mode access
  const dictAccessTest = new BenchmarkRunner("Dictionary Mode Access", {
    iterations: 1000000,
    samples: 10,
  });

  let dictIdx = 0;
  const dictAccessResult = await dictAccessTest.run(() => {
    const obj = dictObjects[dictIdx++ % dictObjects.length];
    let sum = obj.a + obj.b + obj.d + obj.e;
  });

  // Test fast mode access
  const fastAccessTest = new BenchmarkRunner("Fast Mode Access", {
    iterations: 1000000,
    samples: 10,
  });

  let fastIdx = 0;
  const fastAccessResult = await fastAccessTest.run(() => {
    const obj = fastObjects[fastIdx++ % fastObjects.length];
    let sum = obj.a + obj.b + obj.d + obj.e;
  });

  console.log("Dictionary Mode:" + BenchmarkRunner.formatResults(dictAccessResult));
  console.log("\nFast Mode:" + BenchmarkRunner.formatResults(fastAccessResult));

  const accessComparison = BenchmarkRunner.compare(fastAccessResult, dictAccessResult);
  console.log(`\nResult: Dictionary mode access is ${accessComparison.summary}`);

  // Test 4: Dynamic Property Management
  console.log("\n" + "-".repeat(50));
  console.log("\n4. DYNAMIC PROPERTY MANAGEMENT\n");

  // Using delete in loops
  const dynamicDeleteTest = new BenchmarkRunner("Dynamic Delete", {
    iterations: 10000,
    samples: 10,
  });

  const dynamicDeleteResult = await dynamicDeleteTest.run(() => {
    const cache = {};
    for (let i = 0; i < 10; i++) {
      cache[`key${i}`] = i;
    }
    for (let i = 0; i < 5; i++) {
      delete cache[`key${i}`];
    }
    let sum = 0;
    for (let key in cache) {
      sum += cache[key];
    }
  });

  // Using undefined in loops
  const dynamicUndefinedTest = new BenchmarkRunner("Dynamic Undefined", {
    iterations: 10000,
    samples: 10,
  });

  const dynamicUndefinedResult = await dynamicUndefinedTest.run(() => {
    const cache = {};
    for (let i = 0; i < 10; i++) {
      cache[`key${i}`] = i;
    }
    for (let i = 0; i < 5; i++) {
      cache[`key${i}`] = undefined;
    }
    let sum = 0;
    for (let key in cache) {
      if (cache[key] !== undefined) {
        sum += cache[key];
      }
    }
  });

  // Using Map for dynamic properties
  const mapTest = new BenchmarkRunner("Map Alternative", {
    iterations: 10000,
    samples: 10,
  });

  const mapResult = await mapTest.run(() => {
    const cache = new Map();
    for (let i = 0; i < 10; i++) {
      cache.set(`key${i}`, i);
    }
    for (let i = 0; i < 5; i++) {
      cache.delete(`key${i}`);
    }
    let sum = 0;
    for (let value of cache.values()) {
      sum += value;
    }
  });

  console.log("Dynamic Delete:" + BenchmarkRunner.formatResults(dynamicDeleteResult));
  console.log("\nDynamic Undefined:" + BenchmarkRunner.formatResults(dynamicUndefinedResult));
  console.log("\nMap Alternative:" + BenchmarkRunner.formatResults(mapResult));

  const dynamicComparison = BenchmarkRunner.compare(dynamicUndefinedResult, dynamicDeleteResult);
  const mapComparison = BenchmarkRunner.compare(mapResult, dynamicDeleteResult);

  console.log("\n" + "-".repeat(50));
  console.log("DYNAMIC MANAGEMENT:");
  console.log(`Delete vs Undefined: ${dynamicComparison.summary}`);
  console.log(`Map vs Delete: ${mapComparison.summary}`);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("BENCHMARK SUMMARY");
  console.log("=".repeat(60));
  console.log(`Single Property: delete is ${deleteComparison.summary}`);
  console.log(`Multiple Properties: delete is ${multiComparison.summary}`);
  console.log(`Dictionary Mode Impact: ${accessComparison.summary}`);
  console.log(`Dynamic Management: delete is ${dynamicComparison.summary}`);

  return {
    singleProperty: deleteComparison.ratio,
    multipleProperties: multiComparison.ratio,
    dictionaryMode: accessComparison.ratio,
    dynamicManagement: dynamicComparison.ratio,
  };
}

module.exports = { runBenchmarks };

if (require.main === module) {
  runBenchmarks().catch(console.error);
}
