/**
 * V8 String Internalization and Optimization
 * ===========================================
 * This file demonstrates how V8 optimizes string storage and comparison
 * through string internalization (also called string interning).
 * 
 * Run with: node string-internalization.js
 * For memory analysis: node --expose-gc --trace-gc string-internalization.js
 * 
 * Key Concepts:
 * - String literals are internalized (single memory location)
 * - String comparison can be pointer comparison (very fast)
 * - Dynamic strings may not be internalized
 * - Memory savings through deduplication
 */

console.log('='.repeat(80));
console.log('V8 STRING INTERNALIZATION AND OPTIMIZATION');
console.log('='.repeat(80));

// ===========================================================================
// PART 1: String Internalization Basics
// ===========================================================================

console.log('\nPART 1: String Internalization Basics');
console.log('-'.repeat(50));

// String literals are automatically internalized
const str1 = 'hello world';
const str2 = 'hello world';
const str3 = 'hello world';

console.log('Three variables with same string literal:');
console.log('str1:', str1);
console.log('str2:', str2);
console.log('str3:', str3);

// These all point to the SAME memory location!
console.log('\nComparison results:');
console.log('str1 === str2:', str1 === str2);  // true (same reference)
console.log('str2 === str3:', str2 === str3);  // true (same reference)
console.log('str1 === str3:', str1 === str3);  // true (same reference)

console.log('\nV8 stores the string "hello world" only ONCE in memory.');
console.log('All three variables point to the same memory location.');

// ===========================================================================
// PART 2: Dynamic Strings vs Literals
// ===========================================================================

console.log('\n\nPART 2: Dynamic Strings vs String Literals');
console.log('-'.repeat(50));

// String literals are internalized
const literal1 = 'constant';
const literal2 = 'constant';

// Dynamically created strings might not be internalized initially
const dynamic1 = 'con' + 'stant';
const dynamic2 = ['c', 'o', 'n', 's', 't', 'a', 'n', 't'].join('');
const dynamic3 = String('constant');
const dynamic4 = `${'con'}${'stant'}`;  // Template literal

console.log('String creation methods:');
console.log('Literal:', literal1);
console.log('Concatenation:', dynamic1);
console.log('Array.join():', dynamic2);
console.log('String():', dynamic3);
console.log('Template:', dynamic4);

console.log('\nComparison results:');
console.log('literal1 === literal2:', literal1 === literal2);  // true
console.log('literal1 === dynamic1:', literal1 === dynamic1);  // true (V8 may intern)
console.log('literal1 === dynamic2:', literal1 === dynamic2);  // true (content same)
console.log('dynamic1 === dynamic2:', dynamic1 === dynamic2);  // may be true

// ===========================================================================
// PART 3: Performance Impact - String Comparison
// ===========================================================================

console.log('\n\nPART 3: Performance Impact of Internalization');
console.log('-'.repeat(50));

const ITERATIONS = 10000000;

// Create test strings
const internedA = 'performance test string that is quite long';
const internedB = 'performance test string that is quite long';

// Force creation of non-interned strings (using Buffer/dynamic generation)
const nonInternedA = Buffer.from('performance test string that is quite long').toString();
const nonInternedB = Buffer.from('performance test string that is quite long').toString();

console.log('Testing string comparison performance...\n');

// Test interned string comparison (pointer comparison)
console.time('Interned strings comparison');
let internedMatches = 0;
for (let i = 0; i < ITERATIONS; i++) {
    if (internedA === internedB) {
        internedMatches++;
    }
}
console.timeEnd('Interned strings comparison');

// Test non-interned string comparison (character-by-character)
console.time('Non-interned strings comparison');
let nonInternedMatches = 0;
for (let i = 0; i < ITERATIONS; i++) {
    if (nonInternedA === nonInternedB) {
        nonInternedMatches++;
    }
}
console.timeEnd('Non-interned strings comparison');

console.log('\nInterned string comparison is often faster (pointer comparison)');

// ===========================================================================
// PART 4: Memory Efficiency Through Internalization
// ===========================================================================

console.log('\n\nPART 4: Memory Efficiency');
console.log('-'.repeat(50));

// Demonstrating memory savings
const STATUS_ACTIVE = 'active';
const STATUS_INACTIVE = 'inactive';
const STATUS_PENDING = 'pending';

// Creating many objects with string properties
const users = [];
for (let i = 0; i < 10000; i++) {
    users.push({
        id: i,
        // These strings are internalized - memory efficient!
        status: i % 3 === 0 ? STATUS_ACTIVE : 
                i % 3 === 1 ? STATUS_INACTIVE : 
                STATUS_PENDING,
        type: 'user',  // Literal - internalized
        role: 'member'  // Literal - internalized
    });
}

console.log(`Created ${users.length} user objects`);
console.log('Status values are internalized - only 3 strings in memory!');
console.log('Without internalization: 10,000 status strings');
console.log('With internalization: 3 status strings');
console.log('Memory savings: ~99.97% for status strings!\n');

// Count unique status values
const uniqueStatuses = new Set(users.map(u => u.status));
console.log('Unique status values:', uniqueStatuses.size);

// ===========================================================================
// PART 5: String Constants Pattern
// ===========================================================================

console.log('\n\nPART 5: String Constants Best Practice');
console.log('-'.repeat(50));

// BAD: Magic strings scattered throughout code
function processOrderBad(order) {
    if (order.status === 'pending') {  // String literal
        order.status = 'processing';  // Another literal
    } else if (order.status === 'processing') {  // Duplicate
        order.status = 'completed';  // Another literal
    }
    return order;
}

// GOOD: String constants (guaranteed internalization)
const ORDER_STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled'
};

function processOrderGood(order) {
    if (order.status === ORDER_STATUS.PENDING) {
        order.status = ORDER_STATUS.PROCESSING;
    } else if (order.status === ORDER_STATUS.PROCESSING) {
        order.status = ORDER_STATUS.COMPLETED;
    }
    return order;
}

console.log('String Constants Pattern Benefits:');
console.log('1. Guaranteed internalization');
console.log('2. Type safety (with TypeScript/JSDoc)');
console.log('3. Centralized management');
console.log('4. Faster comparisons');
console.log('5. Memory efficiency');

// ===========================================================================
// PART 6: String Building Performance
// ===========================================================================

console.log('\n\nPART 6: Efficient String Building');
console.log('-'.repeat(50));

const BUILD_ITERATIONS = 100000;

// Method 1: String concatenation with +=
console.time('String += concatenation');
let concat = '';
for (let i = 0; i < BUILD_ITERATIONS; i++) {
    concat += 'a';
}
console.timeEnd('String += concatenation');

// Method 2: Array join
console.time('Array.join()');
const parts = [];
for (let i = 0; i < BUILD_ITERATIONS; i++) {
    parts.push('a');
}
const joined = parts.join('');
console.timeEnd('Array.join()');

// Method 3: Template literals (small strings)
console.time('Template literals');
let template = '';
for (let i = 0; i < BUILD_ITERATIONS; i++) {
    template = `${template}a`;
}
console.timeEnd('Template literals');

console.log('\nModern V8 optimizes += well for string building');
console.log('Array.join() is still efficient for very large strings');

// ===========================================================================
// PART 7: String Comparison Optimizations
// ===========================================================================

console.log('\n\nPART 7: String Comparison Patterns');
console.log('-'.repeat(50));

// Pattern 1: Use === for string comparison (fastest)
const str = 'test';
console.log('Patterns for string comparison:');
console.log('1. === (fastest):', str === 'test');
console.log('2. == (slower, type coercion):', str == 'test');

// Pattern 2: Early exit for length check
function compareStringsSmart(a, b) {
    // Early exit if lengths differ
    if (a.length !== b.length) return false;
    return a === b;
}

// Pattern 3: Use startsWith/endsWith for partial matches
const url = 'https://example.com/api/users';
console.log('\nPartial matching methods:');
console.log('startsWith("https"):', url.startsWith('https'));
console.log('endsWith("/users"):', url.endsWith('/users'));
console.log('includes("/api/"):', url.includes('/api/'));

// ===========================================================================
// PART 8: Practical String Optimization Tips
// ===========================================================================

console.log('\n\nPART 8: Practical Optimization Tips');
console.log('-'.repeat(50));

// Tip 1: Intern frequently used strings
const cache = new Map();
function internString(str) {
    // Manual interning for dynamic strings
    if (!cache.has(str)) {
        cache.set(str, str);
    }
    return cache.get(str);
}

// Tip 2: Use symbols for internal properties
const PRIVATE_ID = Symbol('id');
const obj = {
    [PRIVATE_ID]: 12345,
    publicId: 'user-12345'
};

// Tip 3: Normalize strings early
function normalizeStatus(status) {
    // Normalize to interned constants
    const normalized = status.toLowerCase().trim();
    switch(normalized) {
        case 'active':
        case 'enabled':
        case 'on':
            return STATUS_ACTIVE;
        case 'inactive':
        case 'disabled':
        case 'off':
            return STATUS_INACTIVE;
        default:
            return STATUS_PENDING;
    }
}

console.log('Optimization tips demonstrated:');
console.log('1. Manual string interning for dynamic strings');
console.log('2. Symbols for property keys (no string comparison)');
console.log('3. Early normalization to constants');

// ===========================================================================
// SUMMARY
// ===========================================================================

console.log('\n\n' + '='.repeat(80));
console.log('STRING OPTIMIZATION BEST PRACTICES');
console.log('='.repeat(80));
console.log(`
STRING INTERNALIZATION:
- String literals are automatically internalized
- Same string literal = single memory location
- String comparison becomes pointer comparison (fast!)
- Dynamic strings may not be initially internalized

MEMORY BENEFITS:
- Dramatic memory savings for repeated strings
- 10,000 "active" strings → 1 string in memory
- Reduces GC pressure
- Improves cache locality

PERFORMANCE PATTERNS:

1. USE STRING CONSTANTS
   const STATUS = { ACTIVE: 'active', INACTIVE: 'inactive' };
   GOOD: Guaranteed internalization
   GOOD: Type safety with TypeScript
   GOOD: Centralized management

2. COMPARISON OPTIMIZATION
   GOOD: Use === (no type coercion)
   GOOD: Length check for early exit
   GOOD: startsWith/endsWith for partial matches
   BAD: Avoid == (type coercion overhead)

3. STRING BUILDING
   GOOD: += is optimized in modern V8
   GOOD: Array.join() for very large strings
   GOOD: Template literals for readability
   BAD: Avoid repeated concatenation in loops

4. PROPERTY KEYS
   GOOD: Use symbols for internal properties
   GOOD: String constants for public properties
   BAD: Avoid dynamic property names

REAL-WORLD TIPS:
- Normalize strings early to constants
- Cache/intern dynamic strings if repeated
- Use constants for all status/type strings
- Profile memory usage with --trace-gc

Remember: String internalization is automatic for literals,
but understanding it helps write more efficient code!
`);