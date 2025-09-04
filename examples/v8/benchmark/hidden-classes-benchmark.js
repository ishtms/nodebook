/**
 * Hidden Classes Performance Benchmark
 * Tests the claim: "Unstable hidden classes show 2-5x slower performance"
 */

const { BenchmarkRunner } = require('./benchmark-utils');

console.log('='.repeat(60));
console.log('HIDDEN CLASSES PERFORMANCE BENCHMARK');
console.log('Testing claim: Unstable hidden classes are 2-5x slower');
console.log('='.repeat(60));

async function runBenchmarks() {
    // Test 1: Consistent vs Inconsistent Property Order
    console.log('\n1. PROPERTY ORDER CONSISTENCY\n');
    
    // Stable hidden class - consistent property order
    const stableOrderTest = new BenchmarkRunner('Stable Property Order', {
        iterations: 1000000,
        samples: 10
    });
    
    const stableResult = await stableOrderTest.run(() => {
        const obj = { x: 1, y: 2, z: 3 };
        let sum = obj.x + obj.y + obj.z;
    });
    
    // Unstable hidden class - inconsistent property order
    const unstableOrderTest = new BenchmarkRunner('Unstable Property Order', {
        iterations: 1000000,
        samples: 10
    });
    
    let counter = 0;
    const unstableResult = await unstableOrderTest.run(() => {
        let obj;
        if (counter++ % 3 === 0) {
            obj = { x: 1, y: 2, z: 3 };
        } else if (counter % 3 === 1) {
            obj = { y: 2, x: 1, z: 3 };
        } else {
            obj = { z: 3, y: 2, x: 1 };
        }
        let sum = obj.x + obj.y + obj.z;
    });
    
    console.log('Stable (consistent order):' + BenchmarkRunner.formatResults(stableResult));
    console.log('\nUnstable (varying order):' + BenchmarkRunner.formatResults(unstableResult));
    
    const orderComparison = BenchmarkRunner.compare(stableResult, unstableResult);
    console.log(`\nResult: Unstable property order is ${orderComparison.summary}`);
    
    // Test 2: Dynamic Property Addition
    console.log('\n' + '-'.repeat(50));
    console.log('\n2. DYNAMIC PROPERTY ADDITION\n');
    
    // Object literal (stable)
    const literalTest = new BenchmarkRunner('Object Literal', {
        iterations: 1000000,
        samples: 10
    });
    
    const literalResult = await literalTest.run(() => {
        const obj = { a: 1, b: 2, c: 3, d: 4, e: 5 };
        let sum = obj.a + obj.b + obj.c + obj.d + obj.e;
    });
    
    // Dynamic property addition (unstable)
    const dynamicTest = new BenchmarkRunner('Dynamic Addition', {
        iterations: 1000000,
        samples: 10
    });
    
    const dynamicResult = await dynamicTest.run(() => {
        const obj = {};
        obj.a = 1;
        obj.b = 2;
        obj.c = 3;
        obj.d = 4;
        obj.e = 5;
        let sum = obj.a + obj.b + obj.c + obj.d + obj.e;
    });
    
    console.log('Object Literal:' + BenchmarkRunner.formatResults(literalResult));
    console.log('\nDynamic Addition:' + BenchmarkRunner.formatResults(dynamicResult));
    
    const dynamicComparison = BenchmarkRunner.compare(literalResult, dynamicResult);
    console.log(`\nResult: Dynamic addition is ${dynamicComparison.summary}`);
    
    // Test 3: Constructor vs Dynamic Creation
    console.log('\n' + '-'.repeat(50));
    console.log('\n3. CONSTRUCTOR VS DYNAMIC CREATION\n');
    
    class Point {
        constructor(x, y) {
            this.x = x;
            this.y = y;
        }
    }
    
    // Constructor pattern (stable)
    const constructorTest = new BenchmarkRunner('Constructor Pattern', {
        iterations: 1000000,
        samples: 10
    });
    
    const constructorResult = await constructorTest.run(() => {
        const p = new Point(10, 20);
        let sum = p.x + p.y;
    });
    
    // Dynamic creation (potentially unstable)
    const factoryTest = new BenchmarkRunner('Dynamic Factory', {
        iterations: 1000000,
        samples: 10
    });
    
    const factoryResult = await factoryTest.run(() => {
        const p = {};
        if (Math.random() > 0.5) {
            p.x = 10;
            p.y = 20;
        } else {
            p.y = 20;
            p.x = 10;
        }
        let sum = p.x + p.y;
    });
    
    console.log('Constructor:' + BenchmarkRunner.formatResults(constructorResult));
    console.log('\nDynamic Factory:' + BenchmarkRunner.formatResults(factoryResult));
    
    const constructorComparison = BenchmarkRunner.compare(constructorResult, factoryResult);
    console.log(`\nResult: Dynamic factory is ${constructorComparison.summary}`);
    
    // Test 4: Property Access with Many Shapes
    console.log('\n' + '-'.repeat(50));
    console.log('\n4. PROPERTY ACCESS WITH SHAPE TRANSITIONS\n');
    
    // Single shape
    const singleShapeTest = new BenchmarkRunner('Single Shape', {
        iterations: 1000000,
        samples: 10
    });
    
    const objects1 = Array(100).fill().map(() => ({ a: 1, b: 2, c: 3 }));
    let idx1 = 0;
    
    const singleShapeResult = await singleShapeTest.run(() => {
        const obj = objects1[idx1++ % objects1.length];
        let sum = obj.a + obj.b + obj.c;
    });
    
    // Multiple shapes
    const multiShapeTest = new BenchmarkRunner('Multiple Shapes', {
        iterations: 1000000,
        samples: 10
    });
    
    const objects2 = [
        ...Array(25).fill().map(() => ({ a: 1, b: 2, c: 3 })),
        ...Array(25).fill().map(() => ({ b: 2, a: 1, c: 3 })),
        ...Array(25).fill().map(() => ({ c: 3, a: 1, b: 2 })),
        ...Array(25).fill().map(() => ({ b: 2, c: 3, a: 1 }))
    ];
    let idx2 = 0;
    
    const multiShapeResult = await multiShapeTest.run(() => {
        const obj = objects2[idx2++ % objects2.length];
        let sum = obj.a + obj.b + obj.c;
    });
    
    console.log('Single Shape:' + BenchmarkRunner.formatResults(singleShapeResult));
    console.log('\nMultiple Shapes:' + BenchmarkRunner.formatResults(multiShapeResult));
    
    const shapeComparison = BenchmarkRunner.compare(singleShapeResult, multiShapeResult);
    console.log(`\nResult: Multiple shapes are ${shapeComparison.summary}`);
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('BENCHMARK SUMMARY');
    console.log('='.repeat(60));
    console.log(`Property Order Impact: ${orderComparison.summary}`);
    console.log(`Dynamic Addition Impact: ${dynamicComparison.summary}`);
    console.log(`Constructor vs Factory: ${constructorComparison.summary}`);
    console.log(`Shape Transitions: ${shapeComparison.summary}`);
    
    return {
        propertyOrder: orderComparison.ratio,
        dynamicAddition: dynamicComparison.ratio,
        constructorVsFactory: constructorComparison.ratio,
        shapeTransitions: shapeComparison.ratio
    };
}

// Export for use in run-all-benchmarks.js
module.exports = { runBenchmarks };

// Run if executed directly
if (require.main === module) {
    runBenchmarks().catch(console.error);
}