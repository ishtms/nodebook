/**
 * Config Object Disaster Performance Benchmark
 * Tests the orignial 100x slowdown scenario: Dynamic config objects can cause 100x slowdown
 */

const { BenchmarkRunner } = require("./benchmark-utils");

console.log("=".repeat(60));
console.log("CONFIG OBJECT DISASTER BENCHMARK");
console.log("Testing impact of dynamic configuration objects");
console.log("=".repeat(60));

async function runBenchmarks() {
  console.log("\n1. STABLE VS DYNAMIC CONFIG OBJECTS\n");

  // Stable config pattern
  const stableTest = new BenchmarkRunner("Stable Config", {
    iterations: 100000,
    samples: 10,
  });

  class StableConfig {
    constructor() {
      this.apiUrl = "https://api.example.com";
      this.timeout = 5000;
      this.retries = 3;
      this.debug = false;
      this.cache = true;
      this.maxConnections = 10;
      this.compression = true;
      this.headers = {};
    }
  }

  function processStableConfig(config) {
    let result = 0;
    if (config.debug) result += 1;
    if (config.cache) result += 2;
    if (config.compression) result += 4;
    result += config.timeout;
    result += config.retries;
    result += config.maxConnections;
    return result;
  }

  const stableConfig = new StableConfig();

  const stableResult = await stableTest.run(() => {
    let result = processStableConfig(stableConfig);
  });

  // Dynamic config pattern (worst case)
  const dynamicTest = new BenchmarkRunner("Dynamic Config", {
    iterations: 100000,
    samples: 10,
  });

  let configCounter = 0;
  function createDynamicConfig() {
    const config = {};
    const options = configCounter++ % 10;

    // Randomly add properties in different orders
    if (options % 2 === 0) {
      config.apiUrl = "https://api.example.com";
      config.timeout = 5000;
    } else {
      config.timeout = 5000;
      config.apiUrl = "https://api.example.com";
    }

    if (options < 5) {
      config.retries = 3;
      config.debug = false;
    } else {
      config.debug = false;
      config.retries = 3;
    }

    if (options < 3) {
      config.cache = true;
      config.maxConnections = 10;
      config.compression = true;
    } else if (options < 6) {
      config.compression = true;
      config.cache = true;
      config.maxConnections = 10;
    } else {
      config.maxConnections = 10;
      config.compression = true;
      config.cache = true;
    }

    config.headers = {};

    return config;
  }

  const dynamicResult = await dynamicTest.run(() => {
    const config = createDynamicConfig();
    let result = processStableConfig(config);
  });

  console.log("Stable Config:" + BenchmarkRunner.formatResults(stableResult));
  console.log("\nDynamic Config:" + BenchmarkRunner.formatResults(dynamicResult));

  const configComparison = BenchmarkRunner.compare(stableResult, dynamicResult);
  console.log(`\nResult: Dynamic config is ${configComparison.summary}`);

  // Test 2: Progressive Shape Degradation
  console.log("\n" + "-".repeat(50));
  console.log("\n2. PROGRESSIVE SHAPE DEGRADATION\n");

  // 1 shape
  const shape1Test = new BenchmarkRunner("1 Config Shape", {
    iterations: 100000,
    samples: 10,
  });

  const configs1 = Array(100)
    .fill()
    .map(() => ({
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
    }));

  let idx1 = 0;
  const shape1Result = await shape1Test.run(() => {
    const config = configs1[idx1++ % configs1.length];
    let sum = config.a + config.b + config.c + config.d + config.e;
  });

  // 10 shapes
  const shape10Test = new BenchmarkRunner("10 Config Shapes", {
    iterations: 100000,
    samples: 10,
  });

  const configs10 = [];
  const props = ["a", "b", "c", "d", "e"];
  for (let i = 0; i < 10; i++) {
    const shuffled = [...props].sort(() => Math.random() - 0.5);
    for (let j = 0; j < 10; j++) {
      const config = {};
      shuffled.forEach((prop, idx) => (config[prop] = idx + 1));
      configs10.push(config);
    }
  }

  let idx10 = 0;
  const shape10Result = await shape10Test.run(() => {
    const config = configs10[idx10++ % configs10.length];
    let sum = config.a + config.b + config.c + config.d + config.e;
  });

  // 50 shapes (extreme case)
  const shape50Test = new BenchmarkRunner("50 Config Shapes", {
    iterations: 100000,
    samples: 10,
  });

  const configs50 = [];
  for (let i = 0; i < 50; i++) {
    const config = {};
    // Create highly variable shapes
    const numProps = 3 + (i % 5);
    for (let j = 0; j < numProps; j++) {
      const propName = props[j % props.length] + (Math.floor(j / props.length) || "");
      config[propName] = j + 1;
    }
    configs50.push(config);
    configs50.push(config); // Add twice for 100 total
  }

  let idx50 = 0;
  const shape50Result = await shape50Test.run(() => {
    const config = configs50[idx50++ % configs50.length];
    let sum = 0;
    for (let key in config) {
      sum += config[key];
    }
  });

  console.log("1 Shape:" + BenchmarkRunner.formatResults(shape1Result));
  console.log("\n10 Shapes:" + BenchmarkRunner.formatResults(shape10Result));
  console.log("\n50 Shapes:" + BenchmarkRunner.formatResults(shape50Result));

  const shape10Comparison = BenchmarkRunner.compare(shape1Result, shape10Result);
  const shape50Comparison = BenchmarkRunner.compare(shape1Result, shape50Result);

  console.log("\n" + "-".repeat(50));
  console.log("SHAPE DEGRADATION IMPACT:");
  console.log(`10 shapes: ${shape10Comparison.summary}`);
  console.log(`50 shapes: ${shape50Comparison.summary}`);

  // Test 3: Real-World Config Scenario
  console.log("\n" + "-".repeat(50));
  console.log("\n3. REAL-WORLD CONFIG PATTERNS\n");

  // Good pattern: Factory with consistent shape
  const goodPatternTest = new BenchmarkRunner("Good Config Pattern", {
    iterations: 50000,
    samples: 10,
  });

  function createGoodConfig(options = {}) {
    return {
      host: options.host || "localhost",
      port: options.port || 3000,
      ssl: options.ssl || false,
      debug: options.debug || false,
      maxRetries: options.maxRetries || 3,
      timeout: options.timeout || 5000,
      compression: options.compression || true,
      cacheEnabled: options.cacheEnabled || true,
      poolSize: options.poolSize || 10,
      keepAlive: options.keepAlive || true,
    };
  }

  const goodConfigs = [
    createGoodConfig(),
    createGoodConfig({ host: "example.com", port: 443, ssl: true }),
    createGoodConfig({ debug: true, maxRetries: 5 }),
    createGoodConfig({ timeout: 10000, compression: false }),
  ];

  let goodIdx = 0;
  const goodResult = await goodPatternTest.run(() => {
    const config = goodConfigs[goodIdx++ % goodConfigs.length];
    let score = 0;
    score += config.port;
    score += config.maxRetries * 10;
    score += config.timeout / 100;
    if (config.ssl) score += 50;
    if (config.debug) score += 25;
    if (config.compression) score += 15;
    if (config.cacheEnabled) score += 20;
    score += config.poolSize * 2;
  });

  // Bad pattern: Dynamic property addition
  const badPatternTest = new BenchmarkRunner("Bad Config Pattern", {
    iterations: 50000,
    samples: 10,
  });

  function createBadConfig(options = {}) {
    const config = {};

    // Conditionally add properties in varying orders
    if (options.host) config.host = options.host;
    if (options.port) config.port = options.port;

    // Sometimes add defaults in different orders
    if (!config.host) {
      if (Math.random() > 0.5) {
        config.host = "localhost";
        config.port = config.port || 3000;
      } else {
        config.port = config.port || 3000;
        config.host = "localhost";
      }
    }

    // Add remaining properties conditionally
    for (const [key, value] of Object.entries(options)) {
      if (!config[key]) {
        config[key] = value;
      }
    }

    // Add defaults for missing properties
    const defaults = {
      ssl: false,
      debug: false,
      maxRetries: 3,
      timeout: 5000,
      compression: true,
      cacheEnabled: true,
      poolSize: 10,
      keepAlive: true,
    };

    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in config)) {
        config[key] = value;
      }
    }

    return config;
  }

  const badConfigs = [
    createBadConfig(),
    createBadConfig({ host: "example.com", port: 443, ssl: true }),
    createBadConfig({ debug: true, maxRetries: 5, extra1: "test" }),
    createBadConfig({ timeout: 10000, compression: false, extra2: "data" }),
  ];

  let badIdx = 0;
  const badResult = await badPatternTest.run(() => {
    const config = badConfigs[badIdx++ % badConfigs.length];
    let score = 0;
    score += config.port || 0;
    score += (config.maxRetries || 0) * 10;
    score += (config.timeout || 0) / 100;
    if (config.ssl) score += 50;
    if (config.debug) score += 25;
    if (config.compression) score += 15;
    if (config.cacheEnabled) score += 20;
    score += (config.poolSize || 0) * 2;
  });

  console.log("Good Pattern:" + BenchmarkRunner.formatResults(goodResult));
  console.log("\nBad Pattern:" + BenchmarkRunner.formatResults(badResult));

  const patternComparison = BenchmarkRunner.compare(goodResult, badResult);
  console.log(`\nResult: Bad pattern is ${patternComparison.summary}`);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("BENCHMARK SUMMARY");
  console.log("=".repeat(60));
  console.log(`Dynamic vs Stable: ${configComparison.summary}`);
  console.log(`10 Shapes Impact: ${shape10Comparison.summary}`);
  console.log(`50 Shapes Impact: ${shape50Comparison.summary}`);
  console.log(`Bad Pattern Impact: ${patternComparison.summary}`);

  // Check if we hit the claimed 100x slowdown
  const worstCase = Math.max(parseFloat(configComparison.ratio), parseFloat(shape50Comparison.ratio), parseFloat(patternComparison.ratio));

  console.log(`\nWorst case slowdown: ${worstCase.toFixed(2)}x`);
  console.log(`100x claim: ${worstCase >= 100 ? "CONFIRMED" : "NOT REPRODUCED"}`);

  return {
    dynamicConfig: configComparison.ratio,
    shapes10: shape10Comparison.ratio,
    shapes50: shape50Comparison.ratio,
    badPattern: patternComparison.ratio,
    worstCase: worstCase.toFixed(2),
  };
}

module.exports = { runBenchmarks };

if (require.main === module) {
  runBenchmarks().catch(console.error);
}
