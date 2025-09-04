/**
 * Array Element Kinds Performance Benchmark
 * Tests the claims:
 * - SMI arrays: Baseline (1x)
 * - Double arrays: ~1.2x slower
 * - Packed arrays: ~2-3x slower
 * - Holey arrays: ~3-5x slower
 * - Dictionary mode: ~10x+ slower
 */

const { BenchmarkRunner } = require('./benchmark-utils');

console.log('='.repeat(60));
console.log('ARRAY ELEMENT KINDS PERFORMANCE BENCHMARK');
console.log('Testing V8 array optimization levels');
console.log('='.repeat(60));

async function runBenchmarks() {
    console.log('\n1. ARRAY ELEMENT KIND TRANSITIONS\n');
    
    // SMI_ELEMENTS (small integers only)
    const smiTest = new BenchmarkRunner('SMI Elements', {
        iterations: 100000,
        samples: 10
    });
    
    const smiResult = await smiTest.run(() => {
        const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        let sum = 0;
        for (let i = 0; i < arr.length; i++) {
            sum += arr[i];
        }
        return sum;
    });
    
    // DOUBLE_ELEMENTS (floating point)
    const doubleTest = new BenchmarkRunner('Double Elements', {
        iterations: 100000,
        samples: 10
    });
    
    const doubleResult = await doubleTest.run(() => {
        const arr = [1.1, 2.2, 3.3, 4.4, 5.5, 6.6, 7.7, 8.8, 9.9, 10.0];
        let sum = 0;
        for (let i = 0; i < arr.length; i++) {
            sum += arr[i];
        }
        return sum;
    });
    
    // PACKED_ELEMENTS (mixed types)
    const packedTest = new BenchmarkRunner('Packed Elements', {
        iterations: 100000,
        samples: 10
    });
    
    const packedResult = await packedTest.run(() => {
        const arr = [1, 'two', 3, 'four', 5, 'six', 7, 'eight', 9, 'ten'];
        let sum = 0;
        for (let i = 0; i < arr.length; i++) {
            if (typeof arr[i] === 'number') {
                sum += arr[i];
            }
        }
        return sum;
    });
    
    // HOLEY_SMI_ELEMENTS
    const holeySmiTest = new BenchmarkRunner('Holey SMI Elements', {
        iterations: 100000,
        samples: 10
    });
    
    const holeySmiResult = await holeySmiTest.run(() => {
        const arr = [1, 2, , 4, 5, , 7, 8, , 10]; // holes
        let sum = 0;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i] !== undefined) {
                sum += arr[i];
            }
        }
        return sum;
    });
    
    // HOLEY_ELEMENTS (mixed with holes)
    const holeyTest = new BenchmarkRunner('Holey Mixed Elements', {
        iterations: 100000,
        samples: 10
    });
    
    const holeyResult = await holeyTest.run(() => {
        const arr = [1, 'two', , 'four', 5, , 7, 'eight', , 'ten'];
        let sum = 0;
        for (let i = 0; i < arr.length; i++) {
            if (typeof arr[i] === 'number') {
                sum += arr[i];
            }
        }
        return sum;
    });
    
    // Dictionary mode (sparse array)
    const dictionaryTest = new BenchmarkRunner('Dictionary Mode', {
        iterations: 100000,
        samples: 10
    });
    
    const dictionaryResult = await dictionaryTest.run(() => {
        const arr = [];
        arr[0] = 1;
        arr[100] = 2;
        arr[200] = 3;
        arr[300] = 4;
        arr[400] = 5;
        
        let sum = 0;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i] !== undefined) {
                sum += arr[i];
            }
        }
        return sum;
    });
    
    console.log('SMI Elements:' + BenchmarkRunner.formatResults(smiResult));
    console.log('\nDouble Elements:' + BenchmarkRunner.formatResults(doubleResult));
    console.log('\nPacked Elements:' + BenchmarkRunner.formatResults(packedResult));
    console.log('\nHoley SMI:' + BenchmarkRunner.formatResults(holeySmiResult));
    console.log('\nHoley Mixed:' + BenchmarkRunner.formatResults(holeyResult));
    console.log('\nDictionary Mode:' + BenchmarkRunner.formatResults(dictionaryResult));
    
    // Calculate relative performance
    const doubleComparison = BenchmarkRunner.compare(smiResult, doubleResult);
    const packedComparison = BenchmarkRunner.compare(smiResult, packedResult);
    const holeySmiComparison = BenchmarkRunner.compare(smiResult, holeySmiResult);
    const holeyComparison = BenchmarkRunner.compare(smiResult, holeyResult);
    const dictionaryComparison = BenchmarkRunner.compare(smiResult, dictionaryResult);
    
    console.log('\n' + '-'.repeat(50));
    console.log('RELATIVE TO SMI ELEMENTS:');
    console.log(`Double Elements: ${doubleComparison.summary}`);
    console.log(`Packed Elements: ${packedComparison.summary}`);
    console.log(`Holey SMI: ${holeySmiComparison.summary}`);
    console.log(`Holey Mixed: ${holeyComparison.summary}`);
    console.log(`Dictionary Mode: ${dictionaryComparison.summary}`);
    
    // Test 2: Array Operations Performance
    console.log('\n' + '-'.repeat(50));
    console.log('\n2. ARRAY OPERATIONS BY ELEMENT KIND\n');
    
    // Map operation on different element kinds
    const mapSmiTest = new BenchmarkRunner('Map on SMI', {
        iterations: 10000,
        samples: 10
    });
    
    const smiArray = Array(100).fill(0).map((_, i) => i);
    
    const mapSmiResult = await mapSmiTest.run(() => {
        const result = smiArray.map(x => x * 2);
    });
    
    const mapDoubleTest = new BenchmarkRunner('Map on Double', {
        iterations: 10000,
        samples: 10
    });
    
    const doubleArray = Array(100).fill(0).map((_, i) => i + 0.1);
    
    const mapDoubleResult = await mapDoubleTest.run(() => {
        const result = doubleArray.map(x => x * 2);
    });
    
    const mapPackedTest = new BenchmarkRunner('Map on Packed', {
        iterations: 10000,
        samples: 10
    });
    
    const packedArray = Array(100).fill(0).map((_, i) => 
        i % 2 === 0 ? i : `str${i}`
    );
    
    const mapPackedResult = await mapPackedTest.run(() => {
        const result = packedArray.map(x => 
            typeof x === 'number' ? x * 2 : x
        );
    });
    
    console.log('Map on SMI:' + BenchmarkRunner.formatResults(mapSmiResult));
    console.log('\nMap on Double:' + BenchmarkRunner.formatResults(mapDoubleResult));
    console.log('\nMap on Packed:' + BenchmarkRunner.formatResults(mapPackedResult));
    
    const mapDoubleComp = BenchmarkRunner.compare(mapSmiResult, mapDoubleResult);
    const mapPackedComp = BenchmarkRunner.compare(mapSmiResult, mapPackedResult);
    
    console.log('\n' + '-'.repeat(50));
    console.log('MAP OPERATION PERFORMANCE:');
    console.log(`Double vs SMI: ${mapDoubleComp.summary}`);
    console.log(`Packed vs SMI: ${mapPackedComp.summary}`);
    
    // Test 3: NaN and Infinity Impact
    console.log('\n' + '-'.repeat(50));
    console.log('\n3. NaN AND INFINITY IMPACT\n');
    
    // Normal doubles
    const normalDoubleTest = new BenchmarkRunner('Normal Doubles', {
        iterations: 100000,
        samples: 10
    });
    
    const normalDoubleResult = await normalDoubleTest.run(() => {
        const arr = [1.1, 2.2, 3.3, 4.4, 5.5];
        let sum = 0;
        for (const val of arr) {
            sum += val;
        }
    });
    
    // With NaN
    const withNaNTest = new BenchmarkRunner('With NaN', {
        iterations: 100000,
        samples: 10
    });
    
    const withNaNResult = await withNaNTest.run(() => {
        const arr = [1.1, 2.2, NaN, 4.4, 5.5];
        let sum = 0;
        for (const val of arr) {
            if (!isNaN(val)) {
                sum += val;
            }
        }
    });
    
    // With Infinity
    const withInfinityTest = new BenchmarkRunner('With Infinity', {
        iterations: 100000,
        samples: 10
    });
    
    const withInfinityResult = await withInfinityTest.run(() => {
        const arr = [1.1, 2.2, Infinity, 4.4, 5.5];
        let sum = 0;
        for (const val of arr) {
            if (isFinite(val)) {
                sum += val;
            }
        }
    });
    
    console.log('Normal Doubles:' + BenchmarkRunner.formatResults(normalDoubleResult));
    console.log('\nWith NaN:' + BenchmarkRunner.formatResults(withNaNResult));
    console.log('\nWith Infinity:' + BenchmarkRunner.formatResults(withInfinityResult));
    
    const nanComparison = BenchmarkRunner.compare(normalDoubleResult, withNaNResult);
    const infinityComparison = BenchmarkRunner.compare(normalDoubleResult, withInfinityResult);
    
    console.log('\n' + '-'.repeat(50));
    console.log('SPECIAL VALUES IMPACT:');
    console.log(`NaN Impact: ${nanComparison.summary}`);
    console.log(`Infinity Impact: ${infinityComparison.summary}`);
    
    // Test 4: Real-world Scenarios
    console.log('\n' + '-'.repeat(50));
    console.log('\n4. REAL-WORLD ARRAY PATTERNS\n');
    
    // Good pattern: Pre-allocated typed array
    const typedArrayTest = new BenchmarkRunner('Typed Array', {
        iterations: 10000,
        samples: 10
    });
    
    const typedArrayResult = await typedArrayTest.run(() => {
        const arr = new Int32Array(100);
        for (let i = 0; i < arr.length; i++) {
            arr[i] = i;
        }
        let sum = 0;
        for (let i = 0; i < arr.length; i++) {
            sum += arr[i];
        }
    });
    
    // Good pattern: Pre-sized array
    const preSizedTest = new BenchmarkRunner('Pre-sized Array', {
        iterations: 10000,
        samples: 10
    });
    
    const preSizedResult = await preSizedTest.run(() => {
        const arr = new Array(100);
        for (let i = 0; i < 100; i++) {
            arr[i] = i;
        }
        let sum = 0;
        for (let i = 0; i < arr.length; i++) {
            sum += arr[i];
        }
    });
    
    // Bad pattern: Growing array
    const growingTest = new BenchmarkRunner('Growing Array', {
        iterations: 10000,
        samples: 10
    });
    
    const growingResult = await growingTest.run(() => {
        const arr = [];
        for (let i = 0; i < 100; i++) {
            arr.push(i);
        }
        let sum = 0;
        for (let i = 0; i < arr.length; i++) {
            sum += arr[i];
        }
    });
    
    // Bad pattern: Type transitions
    const transitionTest = new BenchmarkRunner('Type Transitions', {
        iterations: 10000,
        samples: 10
    });
    
    const transitionResult = await transitionTest.run(() => {
        const arr = [];
        // Start with SMI
        for (let i = 0; i < 50; i++) {
            arr.push(i);
        }
        // Transition to DOUBLE
        arr.push(3.14);
        // Continue with doubles
        for (let i = 51; i < 99; i++) {
            arr.push(i + 0.1);
        }
        // Transition to PACKED
        arr.push('string');
        
        let sum = 0;
        for (let i = 0; i < arr.length; i++) {
            if (typeof arr[i] === 'number') {
                sum += arr[i];
            }
        }
    });
    
    console.log('Typed Array:' + BenchmarkRunner.formatResults(typedArrayResult));
    console.log('\nPre-sized Array:' + BenchmarkRunner.formatResults(preSizedResult));
    console.log('\nGrowing Array:' + BenchmarkRunner.formatResults(growingResult));
    console.log('\nType Transitions:' + BenchmarkRunner.formatResults(transitionResult));
    
    const typedComparison = BenchmarkRunner.compare(typedArrayResult, preSizedResult);
    const growingComparison = BenchmarkRunner.compare(preSizedResult, growingResult);
    const transitionComparison = BenchmarkRunner.compare(preSizedResult, transitionResult);
    
    console.log('\n' + '-'.repeat(50));
    console.log('REAL-WORLD PATTERNS:');
    console.log(`Typed vs Pre-sized: ${typedComparison.summary}`);
    console.log(`Growing vs Pre-sized: ${growingComparison.summary}`);
    console.log(`Transitions vs Pre-sized: ${transitionComparison.summary}`);
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('BENCHMARK SUMMARY');
    console.log('='.repeat(60));
    console.log('Element Kind Performance:');
    console.log(`  Double: ${doubleComparison.summary}`);
    console.log(`  Packed: ${packedComparison.summary}`);
    console.log(`  Holey SMI: ${holeySmiComparison.summary}`);
    console.log(`  Holey Mixed: ${holeyComparison.summary}`);
    console.log(`  Dictionary: ${dictionaryComparison.summary}`);
    console.log('\nSpecial Values:');
    console.log(`  NaN: ${nanComparison.summary}`);
    console.log(`  Infinity: ${infinityComparison.summary}`);
    
    return {
        double: doubleComparison.ratio,
        packed: packedComparison.ratio,
        holeySmi: holeySmiComparison.ratio,
        holeyMixed: holeyComparison.ratio,
        dictionary: dictionaryComparison.ratio,
        nan: nanComparison.ratio,
        infinity: infinityComparison.ratio
    };
}

module.exports = { runBenchmarks };

if (require.main === module) {
    runBenchmarks().catch(console.error);
}