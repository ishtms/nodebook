/**
 * Monomorphic vs Polymorphic Patterns Benchmark
 * Tests my claims:
 * - Polymorphic (2-4 shapes): 2-5x slower
 * - Megamorphic (5+ shapes): 10-50x slower
 */

const { BenchmarkRunner } = require("./benchmark-utils");

console.log("=".repeat(60));
console.log("MONOMORPHIC VS POLYMORPHIC PATTERNS BENCHMARK");
console.log("Testing performance impact of shape diversity");
console.log("=".repeat(60));

async function runBenchmarks() {
  console.log("\n1. BASIC PROPERTY ACCESS PATTERNS\n");

  // Test with consistent shapes (monomorphic)
  const monoTest = new BenchmarkRunner("Monomorphic Pattern", {
    iterations: 1000000,
    samples: 10,
  });

  function sumProperties(obj) {
    return obj.a + obj.b + obj.c + obj.d + obj.e;
  }

  const monoObject = { a: 1, b: 2, c: 3, d: 4, e: 5 };

  const monoResult = await monoTest.run(() => {
    let result = sumProperties(monoObject);
  });

  // Test with 2 shapes (polymorphic)
  const poly2Test = new BenchmarkRunner("Polymorphic (2 shapes)", {
    iterations: 1000000,
    samples: 10,
  });

  const shape1 = { a: 1, b: 2, c: 3, d: 4, e: 5 };
  const shape2 = { b: 2, a: 1, d: 4, c: 3, e: 5 };
  let poly2Counter = 0;

  const poly2Result = await poly2Test.run(() => {
    const obj = poly2Counter++ % 2 === 0 ? shape1 : shape2;
    let result = sumProperties(obj);
  });

  // Test with 4 shapes (polymorphic)
  const poly4Test = new BenchmarkRunner("Polymorphic (4 shapes)", {
    iterations: 1000000,
    samples: 10,
  });

  const shapes4 = [
    { a: 1, b: 2, c: 3, d: 4, e: 5 },
    { b: 2, a: 1, c: 3, d: 4, e: 5 },
    { c: 3, b: 2, a: 1, d: 4, e: 5 },
    { d: 4, c: 3, b: 2, a: 1, e: 5 },
  ];
  let poly4Counter = 0;

  const poly4Result = await poly4Test.run(() => {
    const obj = shapes4[poly4Counter++ % 4];
    let result = sumProperties(obj);
  });

  // Test with many shapes (megamorphic)
  const megaTest = new BenchmarkRunner("Megamorphic (8 shapes)", {
    iterations: 1000000,
    samples: 10,
  });

  const megaShapes = [];
  const props = ["a", "b", "c", "d", "e"];

  // Create 8 different permutations
  for (let i = 0; i < 8; i++) {
    const shuffled = [...props].sort(() => Math.random() - 0.5);
    const obj = {};
    shuffled.forEach((prop, idx) => (obj[prop] = idx + 1));
    megaShapes.push(obj);
  }

  let megaCounter = 0;

  const megaResult = await megaTest.run(() => {
    const obj = megaShapes[megaCounter++ % megaShapes.length];
    let result = sumProperties(obj);
  });

  console.log("Monomorphic:" + BenchmarkRunner.formatResults(monoResult));
  console.log("\nPolymorphic (2):" + BenchmarkRunner.formatResults(poly2Result));
  console.log("\nPolymorphic (4):" + BenchmarkRunner.formatResults(poly4Result));
  console.log("\nMegamorphic (8):" + BenchmarkRunner.formatResults(megaResult));

  const poly2Comparison = BenchmarkRunner.compare(monoResult, poly2Result);
  const poly4Comparison = BenchmarkRunner.compare(monoResult, poly4Result);
  const megaComparison = BenchmarkRunner.compare(monoResult, megaResult);

  console.log("\n" + "-".repeat(50));
  console.log("RELATIVE PERFORMANCE:");
  console.log(`Polymorphic (2): ${poly2Comparison.summary}`);
  console.log(`Polymorphic (4): ${poly4Comparison.summary}`);
  console.log(`Megamorphic (8): ${megaComparison.summary}`);

  // Test 2: Array Processing with Different Shapes
  console.log("\n" + "-".repeat(50));
  console.log("\n2. ARRAY PROCESSING PATTERNS\n");

  // Monomorphic array processing
  const monoArrayTest = new BenchmarkRunner("Monomorphic Array", {
    iterations: 100000,
    samples: 10,
  });

  const monoArray = Array(100)
    .fill()
    .map(() => ({
      id: Math.random(),
      value: Math.random() * 100,
      status: "active",
    }));

  const monoArrayResult = await monoArrayTest.run(() => {
    let sum = 0;
    for (const item of monoArray) {
      sum += item.value;
    }
  });

  // Polymorphic array processing
  const polyArrayTest = new BenchmarkRunner("Polymorphic Array", {
    iterations: 100000,
    samples: 10,
  });

  const polyArray = [];
  for (let i = 0; i < 100; i++) {
    if (i % 4 === 0) {
      polyArray.push({ id: i, value: Math.random() * 100, status: "active" });
    } else if (i % 4 === 1) {
      polyArray.push({ value: Math.random() * 100, id: i, status: "active" });
    } else if (i % 4 === 2) {
      polyArray.push({ status: "active", id: i, value: Math.random() * 100 });
    } else {
      polyArray.push({ value: Math.random() * 100, status: "active", id: i });
    }
  }

  const polyArrayResult = await polyArrayTest.run(() => {
    let sum = 0;
    for (const item of polyArray) {
      sum += item.value;
    }
  });

  console.log("Monomorphic Array:" + BenchmarkRunner.formatResults(monoArrayResult));
  console.log("\nPolymorphic Array:" + BenchmarkRunner.formatResults(polyArrayResult));

  const arrayComparison = BenchmarkRunner.compare(monoArrayResult, polyArrayResult);
  console.log(`\nResult: Polymorphic array is ${arrayComparison.summary}`);

  // Test 3: Map/Filter Operations
  console.log("\n" + "-".repeat(50));
  console.log("\n3. MAP/FILTER OPERATIONS\n");

  // Monomorphic map operation
  const monoMapTest = new BenchmarkRunner("Monomorphic Map", {
    iterations: 10000,
    samples: 10,
  });

  const monoMapData = Array(100)
    .fill()
    .map((_, i) => ({
      x: i,
      y: i * 2,
      z: i * 3,
    }));

  const monoMapResult = await monoMapTest.run(() => {
    const result = monoMapData.map((obj) => ({
      sum: obj.x + obj.y + obj.z,
      product: obj.x * obj.y * obj.z,
    }));
  });

  // Polymorphic map operation
  const polyMapTest = new BenchmarkRunner("Polymorphic Map", {
    iterations: 10000,
    samples: 10,
  });

  const polyMapData = [];
  for (let i = 0; i < 100; i++) {
    if (i % 3 === 0) {
      polyMapData.push({ x: i, y: i * 2, z: i * 3 });
    } else if (i % 3 === 1) {
      polyMapData.push({ y: i * 2, x: i, z: i * 3 });
    } else {
      polyMapData.push({ z: i * 3, y: i * 2, x: i });
    }
  }

  const polyMapResult = await polyMapTest.run(() => {
    const result = polyMapData.map((obj) => ({
      sum: obj.x + obj.y + obj.z,
      product: obj.x * obj.y * obj.z,
    }));
  });

  console.log("Monomorphic Map:" + BenchmarkRunner.formatResults(monoMapResult));
  console.log("\nPolymorphic Map:" + BenchmarkRunner.formatResults(polyMapResult));

  const mapComparison = BenchmarkRunner.compare(monoMapResult, polyMapResult);
  console.log(`\nResult: Polymorphic map is ${mapComparison.summary}`);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("BENCHMARK SUMMARY");
  console.log("=".repeat(60));
  console.log("Basic Access Patterns:");
  console.log(`  Polymorphic (2): ${poly2Comparison.summary}`);
  console.log(`  Polymorphic (4): ${poly4Comparison.summary}`);
  console.log(`  Megamorphic (8): ${megaComparison.summary}`);
  console.log(`Array Processing: ${arrayComparison.summary}`);
  console.log(`Map Operations: ${mapComparison.summary}`);

  return {
    poly2: poly2Comparison.ratio,
    poly4: poly4Comparison.ratio,
    megamorphic: megaComparison.ratio,
    arrayProcessing: arrayComparison.ratio,
    mapOperations: mapComparison.ratio,
  };
}

module.exports = { runBenchmarks };

if (require.main === module) {
  runBenchmarks().catch(console.error);
}
