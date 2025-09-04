/**
 * V8 Benchmark Utilities
 * Provides consistent benchmarking infrastructure for all tests
 */

class BenchmarkRunner {
    constructor(name, options = {}) {
        this.name = name;
        this.iterations = options.iterations || 1000000;
        this.warmupIterations = options.warmupIterations || 10000;
        this.samples = options.samples || 10;
        this.results = [];
    }

    /**
     * Run a benchmark test with multiple samples
     */
    async run(testFn, setupFn = null) {
        // Warmup phase - let V8 optimize
        if (setupFn) setupFn();
        for (let i = 0; i < this.warmupIterations; i++) {
            testFn();
        }

        const times = [];
        
        for (let sample = 0; sample < this.samples; sample++) {
            if (setupFn) setupFn();
            
            const start = process.hrtime.bigint();
            for (let i = 0; i < this.iterations; i++) {
                testFn();
            }
            const end = process.hrtime.bigint();
            
            times.push(Number(end - start) / 1000000); // Convert to milliseconds
        }

        // Remove outliers (top and bottom 10%)
        times.sort((a, b) => a - b);
        const trimCount = Math.floor(times.length * 0.1);
        const trimmedTimes = times.slice(trimCount, times.length - trimCount);

        return {
            name: this.name,
            mean: trimmedTimes.reduce((a, b) => a + b, 0) / trimmedTimes.length,
            median: trimmedTimes[Math.floor(trimmedTimes.length / 2)],
            min: trimmedTimes[0],
            max: trimmedTimes[trimmedTimes.length - 1],
            iterations: this.iterations,
            samples: this.samples
        };
    }

    /**
     * Compare two benchmark results
     */
    static compare(baseline, test) {
        const ratio = test.mean / baseline.mean;
        const percentDiff = ((test.mean - baseline.mean) / baseline.mean) * 100;
        
        return {
            ratio: ratio.toFixed(2),
            percentDifference: percentDiff.toFixed(1),
            fasterSlower: ratio > 1 ? 'slower' : 'faster',
            summary: ratio > 1 
                ? `${ratio.toFixed(2)}x slower`
                : `${(1/ratio).toFixed(2)}x faster`
        };
    }

    /**
     * Format results for display
     */
    static formatResults(result) {
        return `
  Mean: ${result.mean.toFixed(2)}ms
  Median: ${result.median.toFixed(2)}ms
  Min: ${result.min.toFixed(2)}ms
  Max: ${result.max.toFixed(2)}ms
  Iterations: ${result.iterations.toLocaleString()}
  Samples: ${result.samples}`;
    }
}

/**
 * Force deoptimization for testing
 */
function forceDeoptimization(fn) {
    try {
        fn({});
        fn([]);
        fn(1);
        fn("string");
        fn(true);
        fn(null);
        fn(undefined);
        fn(Symbol());
        fn(1n);
    } catch (e) {
        // Ignore errors from type mismatches
    }
}

/**
 * Create objects with specific hidden class patterns
 */
function createObjectWithShape(properties) {
    const obj = {};
    for (const prop of properties) {
        obj[prop] = 1;
    }
    return obj;
}

/**
 * Measure memory allocation
 */
function measureMemory(fn, iterations = 1000) {
    if (global.gc) {
        global.gc();
    }
    
    const before = process.memoryUsage();
    
    for (let i = 0; i < iterations; i++) {
        fn();
    }
    
    if (global.gc) {
        global.gc();
    }
    
    const after = process.memoryUsage();
    
    return {
        heapUsed: (after.heapUsed - before.heapUsed) / iterations,
        external: (after.external - before.external) / iterations,
        arrayBuffers: (after.arrayBuffers - before.arrayBuffers) / iterations
    };
}

module.exports = {
    BenchmarkRunner,
    forceDeoptimization,
    createObjectWithShape,
    measureMemory
};