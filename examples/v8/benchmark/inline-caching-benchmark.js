/**
 * Inline Caching States Performance Benchmark
 * Tests the claims:
 * - Polymorphic (2 shapes): ~2x slower
 * - Polymorphic (4 shapes): ~3-4x slower  
 * - Megamorphic: 10-50x slower
 */

const { BenchmarkRunner } = require('./benchmark-utils');

console.log('='.repeat(60));
console.log('INLINE CACHING STATES PERFORMANCE BENCHMARK');
console.log('Testing IC state performance impact');
console.log('='.repeat(60));

async function runBenchmarks() {
    console.log('\n1. PROPERTY ACCESS PERFORMANCE BY IC STATE\n');
    
    // Monomorphic - single shape
    const monomorphicTest = new BenchmarkRunner('Monomorphic (1 shape)', {
        iterations: 1000000,
        samples: 10
    });
    
    const monoObjects = Array(100).fill().map(() => ({
        x: Math.random() * 100,
        y: Math.random() * 100,
        z: Math.random() * 100
    }));
    
    let monoIdx = 0;
    const monoResult = await monomorphicTest.run(() => {
        const obj = monoObjects[monoIdx++ % monoObjects.length];
        let sum = obj.x + obj.y + obj.z;
    });
    
    // Polymorphic - 2 shapes
    const poly2Test = new BenchmarkRunner('Polymorphic (2 shapes)', {
        iterations: 1000000,
        samples: 10
    });
    
    const poly2Objects = [
        ...Array(50).fill().map(() => ({
            x: Math.random() * 100,
            y: Math.random() * 100,
            z: Math.random() * 100
        })),
        ...Array(50).fill().map(() => ({
            y: Math.random() * 100,
            x: Math.random() * 100,
            z: Math.random() * 100
        }))
    ];
    
    let poly2Idx = 0;
    const poly2Result = await poly2Test.run(() => {
        const obj = poly2Objects[poly2Idx++ % poly2Objects.length];
        let sum = obj.x + obj.y + obj.z;
    });
    
    // Polymorphic - 4 shapes
    const poly4Test = new BenchmarkRunner('Polymorphic (4 shapes)', {
        iterations: 1000000,
        samples: 10
    });
    
    const poly4Objects = [
        ...Array(25).fill().map(() => ({ x: 1, y: 2, z: 3 })),
        ...Array(25).fill().map(() => ({ y: 2, x: 1, z: 3 })),
        ...Array(25).fill().map(() => ({ z: 3, x: 1, y: 2 })),
        ...Array(25).fill().map(() => ({ z: 3, y: 2, x: 1 }))
    ];
    
    let poly4Idx = 0;
    const poly4Result = await poly4Test.run(() => {
        const obj = poly4Objects[poly4Idx++ % poly4Objects.length];
        let sum = obj.x + obj.y + obj.z;
    });
    
    // Megamorphic - many shapes
    const megaTest = new BenchmarkRunner('Megamorphic (10+ shapes)', {
        iterations: 1000000,
        samples: 10
    });
    
    const megaObjects = [];
    const props = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    
    // Create 10 different object shapes
    for (let i = 0; i < 10; i++) {
        const shuffled = [...props].sort(() => Math.random() - 0.5);
        for (let j = 0; j < 10; j++) {
            const obj = {};
            shuffled.forEach(prop => obj[prop] = Math.random() * 100);
            megaObjects.push(obj);
        }
    }
    
    let megaIdx = 0;
    const megaResult = await megaTest.run(() => {
        const obj = megaObjects[megaIdx++ % megaObjects.length];
        let sum = obj.a + obj.b + obj.c;
    });
    
    // Display results
    console.log('Monomorphic:' + BenchmarkRunner.formatResults(monoResult));
    console.log('\nPolymorphic (2):' + BenchmarkRunner.formatResults(poly2Result));
    console.log('\nPolymorphic (4):' + BenchmarkRunner.formatResults(poly4Result));
    console.log('\nMegamorphic:' + BenchmarkRunner.formatResults(megaResult));
    
    // Calculate performance ratios
    const poly2Comparison = BenchmarkRunner.compare(monoResult, poly2Result);
    const poly4Comparison = BenchmarkRunner.compare(monoResult, poly4Result);
    const megaComparison = BenchmarkRunner.compare(monoResult, megaResult);
    
    console.log('\n' + '-'.repeat(50));
    console.log('PERFORMANCE IMPACT (relative to monomorphic):');
    console.log(`Polymorphic (2 shapes): ${poly2Comparison.summary}`);
    console.log(`Polymorphic (4 shapes): ${poly4Comparison.summary}`);
    console.log(`Megamorphic (10+ shapes): ${megaComparison.summary}`);
    
    // Test 2: Function call IC states
    console.log('\n' + '-'.repeat(50));
    console.log('\n2. FUNCTION CALL IC STATES\n');
    
    function processNumber(x) { return x * 2; }
    function processString(s) { return s.toUpperCase(); }
    function processArray(arr) { return arr.length; }
    function processObject(obj) { return obj.value; }
    
    // Monomorphic function calls
    const monoCallTest = new BenchmarkRunner('Monomorphic Calls', {
        iterations: 1000000,
        samples: 10
    });
    
    const monoCallResult = await monoCallTest.run(() => {
        let result = processNumber(42);
    });
    
    // Polymorphic function calls
    const polyCallTest = new BenchmarkRunner('Polymorphic Calls', {
        iterations: 1000000,
        samples: 10
    });
    
    let callCounter = 0;
    const polyCallResult = await polyCallTest.run(() => {
        let result;
        const type = callCounter++ % 4;
        if (type === 0) result = processNumber(42);
        else if (type === 1) result = processString("test");
        else if (type === 2) result = processArray([1, 2, 3]);
        else result = processObject({ value: 10 });
    });
    
    console.log('Monomorphic Calls:' + BenchmarkRunner.formatResults(monoCallResult));
    console.log('\nPolymorphic Calls:' + BenchmarkRunner.formatResults(polyCallResult));
    
    const callComparison = BenchmarkRunner.compare(monoCallResult, polyCallResult);
    console.log(`\nResult: Polymorphic calls are ${callComparison.summary}`);
    
    // Test 3: Method lookup performance
    console.log('\n' + '-'.repeat(50));
    console.log('\n3. METHOD LOOKUP PERFORMANCE\n');
    
    class Base {
        getValue() { return this.value; }
    }
    
    class TypeA extends Base {
        constructor() { super(); this.value = 1; }
    }
    
    class TypeB extends Base {
        constructor() { super(); this.value = 2; this.extra = 0; }
    }
    
    class TypeC extends Base {
        constructor() { super(); this.value = 3; this.extra = 0; this.more = 0; }
    }
    
    // Monomorphic method calls
    const monoMethodTest = new BenchmarkRunner('Monomorphic Methods', {
        iterations: 1000000,
        samples: 10
    });
    
    const monoInstances = Array(100).fill().map(() => new TypeA());
    let monoMethodIdx = 0;
    
    const monoMethodResult = await monoMethodTest.run(() => {
        const instance = monoInstances[monoMethodIdx++ % monoInstances.length];
        let result = instance.getValue();
    });
    
    // Polymorphic method calls
    const polyMethodTest = new BenchmarkRunner('Polymorphic Methods', {
        iterations: 1000000,
        samples: 10
    });
    
    const polyInstances = [
        ...Array(33).fill().map(() => new TypeA()),
        ...Array(33).fill().map(() => new TypeB()),
        ...Array(34).fill().map(() => new TypeC())
    ];
    let polyMethodIdx = 0;
    
    const polyMethodResult = await polyMethodTest.run(() => {
        const instance = polyInstances[polyMethodIdx++ % polyInstances.length];
        let result = instance.getValue();
    });
    
    console.log('Monomorphic Methods:' + BenchmarkRunner.formatResults(monoMethodResult));
    console.log('\nPolymorphic Methods:' + BenchmarkRunner.formatResults(polyMethodResult));
    
    const methodComparison = BenchmarkRunner.compare(monoMethodResult, polyMethodResult);
    console.log(`\nResult: Polymorphic methods are ${methodComparison.summary}`);
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('BENCHMARK SUMMARY');
    console.log('='.repeat(60));
    console.log('Property Access:');
    console.log(`  Polymorphic (2): ${poly2Comparison.summary}`);
    console.log(`  Polymorphic (4): ${poly4Comparison.summary}`);
    console.log(`  Megamorphic: ${megaComparison.summary}`);
    console.log(`Function Calls: ${callComparison.summary}`);
    console.log(`Method Lookup: ${methodComparison.summary}`);
    
    return {
        poly2: poly2Comparison.ratio,
        poly4: poly4Comparison.ratio,
        megamorphic: megaComparison.ratio,
        functionCalls: callComparison.ratio,
        methodLookup: methodComparison.ratio
    };
}

module.exports = { runBenchmarks };

if (require.main === module) {
    runBenchmarks().catch(console.error);
}