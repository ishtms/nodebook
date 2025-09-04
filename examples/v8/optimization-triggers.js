/**
 * V8 Optimization Triggers and Patterns
 * ======================================
 * This file demonstrates V8-friendly code patterns that trigger optimization
 * and maintain high performance. These are the patterns you SHOULD use.
 * 
 * Run with: node --allow-natives-syntax optimization-triggers.js
 * For optimization details: node --trace-opt optimization-triggers.js
 * 
 * Key Patterns:
 * 1. Consistent object shapes via classes/constructors
 * 2. SMI (Small Integer) optimizations
 * 3. Monomorphic function design
 * 4. Predictable control flow
 * 5. Optimizable loops
 * 6. Factory patterns for stable shapes
 */

console.log('='.repeat(80));
console.log('V8 OPTIMIZATION TRIGGERS - PERFORMANCE-FRIENDLY PATTERNS');
console.log('='.repeat(80));

// ===========================================================================
// PATTERN 1: Class-Based Objects for Guaranteed Shape Consistency
// ===========================================================================

console.log('\nGOOD: PATTERN 1: Class-Based Objects with Stable Shapes');
console.log('-'.repeat(50));

// OPTIMAL: Using a class ensures all instances share the same hidden class
class DataPacket {
    constructor(id, timestamp, payloadType, payload, priority = 0) {
        // Initialize ALL properties in constructor, in the SAME order
        this.id = id;                    // SMI if possible
        this.timestamp = timestamp;      // Number
        this.payloadType = payloadType; // String (internalized)
        this.payload = payload;          // Object or null
        this.priority = priority;        // SMI
        this.processed = false;         // Boolean
        this.retryCount = 0;           // SMI
        this.metadata = null;          // Pre-initialized for stability
    }
    
    // Methods don't affect hidden class
    process() {
        this.processed = true;
        this.timestamp = Date.now();
    }
    
    retry() {
        this.retryCount++;
        return this.retryCount < 3;
    }
}

// Create many instances - they all share the same hidden class
const packets = [];
for (let i = 0; i < 1000; i++) {
    packets.push(new DataPacket(
        i,                          // id
        Date.now(),                 // timestamp
        i % 2 ? 'USER' : 'SYSTEM', // payloadType
        { data: 'test' + i },      // payload
        i % 3                       // priority
    ));
}

// Monomorphic function optimized for DataPacket
function processPacket(packet) {
    // V8 can optimize property access to direct memory reads
    const id = packet.id;
    const type = packet.payloadType;
    
    // SMI operations are super fast
    if ((id & 1) === 0) {  // Even ID check using bitwise AND
        packet.priority = (packet.priority + 1) | 0;  // Keep as SMI
    }
    
    if (!packet.processed) {
        packet.process();
    }
    
    return packet;
}

// Warm up and optimize
for (let i = 0; i < 10000; i++) {
    processPacket(packets[i % packets.length]);
}

console.log('DataPacket instances created: 1000');
console.log('All share the same hidden class: GOOD:');

// ===========================================================================
// PATTERN 2: SMI (Small Integer) Optimizations
// ===========================================================================

console.log('\n\nGOOD: PATTERN 2: SMI-Friendly Integer Operations');
console.log('-'.repeat(50));

// SMIs are integers that fit in a 31-bit signed integer (-1B to +1B)
// They're stored directly without heap allocation

// OPTIMAL: Keep numbers as SMIs
function smiOptimized(n) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
        // Bitwise OR with 0 ensures SMI representation
        sum = (sum + i) | 0;
    }
    return sum;
}

// SUB-OPTIMAL: Floating point operations
function floatVersion(n) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum = sum + i + 0.1 - 0.1;  // Forces heap number
    }
    return sum;
}

const SMI_ITERATIONS = 1000000;

console.time('SMI optimized');
smiOptimized(SMI_ITERATIONS);
console.timeEnd('SMI optimized');

console.time('Float version');
floatVersion(SMI_ITERATIONS);
console.timeEnd('Float version');

console.log('Note: SMI operations are significantly faster than floating point');
console.log('(Array benchmarks showed 2.0x difference for SMI vs Double arrays)');

// ===========================================================================
// PATTERN 3: Factory Functions with Stable Shapes
// ===========================================================================

console.log('\n\nGOOD: PATTERN 3: Factory Functions for Consistent Objects');
console.log('-'.repeat(50));

// OPTIMAL: Factory that always creates the same shape
function createUser(data = {}) {
    return {
        // Always initialize ALL properties
        id: data.id || 0,
        name: data.name || '',
        email: data.email || '',
        age: data.age || 0,
        role: data.role || 'user',
        permissions: data.permissions || null,
        createdAt: data.createdAt || Date.now(),
        lastLogin: data.lastLogin || null,
        isActive: data.isActive !== undefined ? data.isActive : true,
        metadata: data.metadata || {}
    };
}

// Alternative: Constructor function (also creates stable shapes)
function User(data = {}) {
    this.id = data.id || 0;
    this.name = data.name || '';
    this.email = data.email || '';
    this.age = data.age || 0;
    this.role = data.role || 'user';
    this.permissions = data.permissions || null;
    this.createdAt = data.createdAt || Date.now();
    this.lastLogin = data.lastLogin || null;
    this.isActive = data.isActive !== undefined ? data.isActive : true;
    this.metadata = data.metadata || {};
}

// Create users with consistent shapes
const users = [
    createUser({ id: 1, name: 'Alice' }),
    createUser({ id: 2, name: 'Bob', role: 'admin' }),
    createUser({ id: 3, name: 'Charlie', age: 30 }),
    new User({ id: 4, name: 'Diana' }),
    new User({ id: 5, name: 'Eve', permissions: ['read', 'write'] })
];

console.log('Factory-created objects with stable shapes: GOOD:');

// ===========================================================================
// PATTERN 4: Optimizable Loop Patterns
// ===========================================================================

console.log('\n\nGOOD: PATTERN 4: Optimization-Friendly Loops');
console.log('-'.repeat(50));

const testArray = new Array(10000).fill(0).map((_, i) => i);

// OPTIMAL: Simple for loop with cached length
function optimizedLoop(arr) {
    let sum = 0;
    const len = arr.length;  // Cache length
    for (let i = 0; i < len; i++) {
        sum += arr[i];
    }
    return sum;
}

// OPTIMAL: While loop with decremental counter
function whileLoopOptimized(arr) {
    let sum = 0;
    let i = arr.length;
    while (i--) {
        sum += arr[i];
    }
    return sum;
}

// GOOD: For-of loop (modern and clean, well-optimized in recent V8)
function forOfLoop(arr) {
    let sum = 0;
    for (const val of arr) {
        sum += val;
    }
    return sum;
}

// SUB-OPTIMAL: forEach with closure
function forEachLoop(arr) {
    let sum = 0;
    arr.forEach(val => {
        sum += val;  // Closure over sum
    });
    return sum;
}

const LOOP_ITERATIONS = 10000;

console.time('For loop (cached length)');
for (let i = 0; i < LOOP_ITERATIONS; i++) {
    optimizedLoop(testArray);
}
console.timeEnd('For loop (cached length)');

console.time('While loop (decremental)');
for (let i = 0; i < LOOP_ITERATIONS; i++) {
    whileLoopOptimized(testArray);
}
console.timeEnd('While loop (decremental)');

console.time('For-of loop');
for (let i = 0; i < LOOP_ITERATIONS; i++) {
    forOfLoop(testArray);
}
console.timeEnd('For-of loop');

console.time('forEach with closure');
for (let i = 0; i < LOOP_ITERATIONS; i++) {
    forEachLoop(testArray);
}
console.timeEnd('forEach with closure');

// ===========================================================================
// PATTERN 5: Predictable Control Flow
// ===========================================================================

console.log('\n\nGOOD: PATTERN 5: Predictable Branching and Control Flow');
console.log('-'.repeat(50));

// OPTIMAL: Predictable branches with consistent types
function predictableBranching(value, type) {
    // Type guard ensures monomorphic operations
    if (type === 'number') {
        return value * 2;           // Always number operation
    } else if (type === 'string') {
        return value + value;       // Always string operation
    } else if (type === 'boolean') {
        return !value;              // Always boolean operation
    }
    return null;
}

// SUB-OPTIMAL: Type checking inside hot path
function unpredictableBranching(value) {
    // Runtime type checking in hot path
    if (typeof value === 'number') {
        return value * 2;
    } else if (typeof value === 'string') {
        return value + value;
    } else if (typeof value === 'boolean') {
        return !value;
    }
    return null;
}

// OPTIMAL: Lookup table for predictable dispatch
const operations = {
    add: (a, b) => a + b,
    subtract: (a, b) => a - b,
    multiply: (a, b) => a * b,
    divide: (a, b) => a / b
};

function lookupTableDispatch(op, a, b) {
    // Single property access, predictable call
    return operations[op](a, b);
}

// ===========================================================================
// PATTERN 6: Inlining-Friendly Functions
// ===========================================================================

console.log('\n\nGOOD: PATTERN 6: Functions Optimized for Inlining');
console.log('-'.repeat(50));

// OPTIMAL: Small, simple functions that V8 will inline
function add(a, b) {
    return a + b;
}

function multiply(a, b) {
    return a * b;
}

function calculate(x, y) {
    // V8 will likely inline add and multiply
    return multiply(add(x, y), 2);
}

// SUB-OPTIMAL: Large functions won't be inlined
function complexCalculation(x, y) {
    // Too much code prevents inlining
    let result = 0;
    for (let i = 0; i < 100; i++) {
        result += x * i;
        result -= y * i;
        if (result > 1000) result = result / 2;
        if (result < -1000) result = result * 2;
    }
    return result;
}

// ===========================================================================
// PATTERN 7: Optimized Property Access Patterns
// ===========================================================================

console.log('\n\nGOOD: PATTERN 7: Efficient Property Access');
console.log('-'.repeat(50));

class ConfigObject {
    constructor() {
        // Pre-define all properties
        this.database = { host: '', port: 0, user: '', password: '' };
        this.server = { port: 0, host: '', ssl: false };
        this.features = { auth: false, logging: false, caching: false };
        this.metadata = {};
    }
}

// OPTIMAL: Direct property access
function getConfigValue(config, section, key) {
    return config[section][key];
}

// OPTIMAL: Destructuring for multiple properties
function processConfig(config) {
    const { host, port } = config.database;
    const { ssl } = config.server;
    
    return `${ssl ? 'https' : 'http'}://${host}:${port}`;
}

// Create config with stable shape
const config = new ConfigObject();
config.database.host = 'localhost';
config.database.port = 5432;
config.server.ssl = true;

console.log('Config URL:', processConfig(config));

// ===========================================================================
// PATTERN 8: Check Optimization Status
// ===========================================================================

console.log('\n\n PATTERN 8: Verifying Optimization Status');
console.log('-'.repeat(50));

// Force optimization of our hot functions
eval('%OptimizeFunctionOnNextCall(processPacket)');
processPacket(packets[0]);

eval('%OptimizeFunctionOnNextCall(smiOptimized)');
smiOptimized(100);

eval('%OptimizeFunctionOnNextCall(optimizedLoop)');
optimizedLoop(testArray);

// Check optimization status
function checkOptimizationStatus(fn) {
    const status = eval(`%GetOptimizationStatus(${fn.name})`);
    const isOptimized = (status & 0x10) !== 0;
    return isOptimized ? 'GOOD: Optimized' : 'BAD: Not Optimized';
}

console.log('Function Optimization Status:');
console.log(`processPacket: ${checkOptimizationStatus(processPacket)}`);
console.log(`smiOptimized: ${checkOptimizationStatus(smiOptimized)}`);
console.log(`optimizedLoop: ${checkOptimizationStatus(optimizedLoop)}`);
console.log(`createUser: ${checkOptimizationStatus(createUser)}`);

// ===========================================================================
// SUMMARY
// ===========================================================================

console.log('\n\n' + '='.repeat(80));
console.log('V8 OPTIMIZATION BEST PRACTICES');
console.log('='.repeat(80));
console.log(`
PATTERNS THAT TRIGGER OPTIMIZATION:

1. STABLE OBJECT SHAPES
   GOOD: Use classes/constructors
   GOOD: Initialize ALL properties
   GOOD: Keep property order consistent

2. SMI-FRIENDLY CODE
   GOOD: Use integers when possible (-1B to +1B)
   GOOD: Bitwise operations (| 0) to maintain SMIs
   GOOD: Avoid unnecessary floating-point ops

3. MONOMORPHIC FUNCTIONS
   GOOD: Design functions for single types
   GOOD: Use type-specific functions
   GOOD: Avoid generic utility functions

4. PREDICTABLE CONTROL FLOW
   GOOD: Consistent branching patterns
   GOOD: Type guards at boundaries
   GOOD: Lookup tables over complex switches

5. OPTIMIZABLE LOOPS
   GOOD: Simple for loops with cached length
   GOOD: Avoid closures in hot loops
   GOOD: Minimize work inside loops

6. INLINING-FRIENDLY
   GOOD: Keep hot functions small and simple
   GOOD: Avoid try-catch in tiny functions
   GOOD: Use consistent calling patterns

7. FACTORY PATTERNS
   GOOD: Return objects with ALL properties
   GOOD: Use consistent defaults
   GOOD: Avoid conditional properties

Remember: V8 rewards boring, predictable code!
Write code that's easy for the compiler to understand.
`);