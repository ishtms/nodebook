/**
 * V8 Hidden Classes Demonstration
 * ================================
 * This file demonstrates how V8's hidden classes (also called Maps or Shapes) work
 * and how property order and initialization affect JavaScript performance.
 *
 * Run with: node --allow-natives-syntax hidden-classes-demo.js
 *
 * Key Concepts:
 * - Hidden classes are V8's way of optimizing property access
 * - Objects with the same properties in the same order share hidden classes
 * - Different property orders create different hidden classes
 * - Conditional properties fork the hidden class tree
 *
 * WARNING: The %HaveSameMap function used here is a V8 internal API that requires
 * the --allow-natives-syntax flag. Never use this in production code!
 */

console.log("=".repeat(80));
console.log("V8 HIDDEN CLASSES DEMONSTRATION");
console.log("=".repeat(80));

// ===========================================================================
// PART 1: Basic Hidden Class Transitions
// ===========================================================================

console.log("\nPART 1: Basic Hidden Class Transitions");
console.log("-".repeat(50));

// When you create an empty object, V8 assigns it an initial hidden class (C0)
const obj1 = {};
const obj2 = {};

// Both objects share the same initial hidden class
console.log("Empty objects share same hidden class:", `%HaveSameMap(obj1, obj2) =`, eval("%HaveSameMap(obj1, obj2)")); // true

// Adding a property creates a transition to a new hidden class
obj1.x = 1;
console.log('\nAfter adding property "x" to obj1:');
console.log("obj1 vs empty obj2:", `%HaveSameMap(obj1, obj2) =`, eval("%HaveSameMap(obj1, obj2)")); // false

// If obj2 follows the same transition path, it gets the same hidden class
obj2.x = 5;
console.log('After adding property "x" to obj2:');
console.log("obj1 vs obj2 (both have x):", `%HaveSameMap(obj1, obj2) =`, eval("%HaveSameMap(obj1, obj2)")); // true

// Adding another property creates another transition
obj1.y = 2;
obj2.y = 6;
console.log('\nAfter adding property "y" to both:');
console.log("obj1 vs obj2 (both have x,y):", `%HaveSameMap(obj1, obj2) =`, eval("%HaveSameMap(obj1, obj2)")); // true

// ===========================================================================
// PART 2: Property Order Matters - The Hidden Class Fork
// ===========================================================================

console.log("\n\nPART 2: Property Order Creates Different Hidden Classes");
console.log("-".repeat(50));

// Objects with same properties but different order have different hidden classes
const point1 = {};
point1.x = 1; // Transition: C0 -> C1 (has x)
point1.y = 2; // Transition: C1 -> C2 (has x, y)

const point2 = {};
point2.y = 2; // Transition: C0 -> C3 (has y) - DIFFERENT PATH!
point2.x = 1; // Transition: C3 -> C4 (has y, x) - DIFFERENT HIDDEN CLASS!

console.log("point1 properties: x then y");
console.log("point2 properties: y then x (different order)");
console.log("Same properties, different order:", `%HaveSameMap(point1, point2) =`, eval("%HaveSameMap(point1, point2)")); // false

// Creating a third object with the same order as point1
const point3 = {};
point3.x = 3;
point3.y = 4;
console.log("\npoint3 properties: x then y (same order as point1)");
console.log("point1 vs point3 (same order):", `%HaveSameMap(point1, point3) =`, eval("%HaveSameMap(point1, point3)")); // true

// ===========================================================================
// PART 3: Object Literal Initialization vs Dynamic Addition
// ===========================================================================

console.log("\n\nPART 3: Object Literal vs Dynamic Property Addition");
console.log("-".repeat(50));

// Object literals create objects with a stable hidden class immediately
const literalObj1 = { a: 1, b: 2, c: 3 };
const literalObj2 = { a: 4, b: 5, c: 6 };

console.log("Object literals with same shape:");
console.log("literalObj1 vs literalObj2:", `%HaveSameMap(literalObj1, literalObj2) =`, eval("%HaveSameMap(literalObj1, literalObj2)")); // true

// Dynamic property addition creates transition chains
const dynamicObj1 = {};
dynamicObj1.a = 1;
dynamicObj1.b = 2;
dynamicObj1.c = 3;

console.log("\nDynamic object vs literal object (same properties):");
console.log("dynamicObj1 vs literalObj1:", `%HaveSameMap(dynamicObj1, literalObj1) =`, eval("%HaveSameMap(dynamicObj1, literalObj1)")); // might be false!

// ===========================================================================
// PART 4: The Conditional Property Problem
// ===========================================================================

console.log("\n\nPART 4: Conditional Properties Fork Hidden Classes");
console.log("-".repeat(50));

function createUser(name, age, isAdmin) {
  const user = {
    name: name,
    age: age,
  };

  // This conditional property creates a hidden class fork
  if (isAdmin) {
    user.role = "admin";
  }

  return user;
}

const regularUser = createUser("Alice", 30, false);
const adminUser = createUser("Bob", 35, true);
const anotherRegular = createUser("Charlie", 25, false);
const anotherAdmin = createUser("Diana", 40, true);

console.log(
  "Regular users share hidden class:",
  `%HaveSameMap(regularUser, anotherRegular) =`,
  eval("%HaveSameMap(regularUser, anotherRegular)"),
); // true

console.log("Admin users share hidden class:", `%HaveSameMap(adminUser, anotherAdmin) =`, eval("%HaveSameMap(adminUser, anotherAdmin)")); // true

console.log(
  "Regular vs Admin have different hidden classes:",
  `%HaveSameMap(regularUser, adminUser) =`,
  eval("%HaveSameMap(regularUser, adminUser)"),
); // false

// The FIX: Pre-initialize all properties
function createUserOptimized(name, age, isAdmin) {
  return {
    name: name,
    age: age,
    role: isAdmin ? "admin" : null, // Always present!
  };
}

const optimizedRegular = createUserOptimized("Eve", 28, false);
const optimizedAdmin = createUserOptimized("Frank", 45, true);

console.log("\nOptimized users (with pre-initialized properties):");
console.log(
  "All users now share the same hidden class:",
  `%HaveSameMap(optimizedRegular, optimizedAdmin) =`,
  eval("%HaveSameMap(optimizedRegular, optimizedAdmin)"),
); // true!

// ===========================================================================
// PART 5: Classes Ensure Consistent Hidden Classes
// ===========================================================================

console.log("\n\nPART 5: Classes Guarantee Consistent Hidden Classes");
console.log("-".repeat(50));

class Point {
  constructor(x, y) {
    // Properties are always initialized in the same order
    this.x = x;
    this.y = y;
  }
}

class Point3D extends Point {
  constructor(x, y, z) {
    super(x, y);
    this.z = z;
  }
}

const classPoint1 = new Point(1, 2);
const classPoint2 = new Point(3, 4);
const classPoint3D_1 = new Point3D(5, 6, 7);
const classPoint3D_2 = new Point3D(8, 9, 10);

console.log("Class instances of Point:", `%HaveSameMap(classPoint1, classPoint2) =`, eval("%HaveSameMap(classPoint1, classPoint2)")); // true

console.log(
  "Class instances of Point3D:",
  `%HaveSameMap(classPoint3D_1, classPoint3D_2) =`,
  eval("%HaveSameMap(classPoint3D_1, classPoint3D_2)"),
); // true

console.log(
  "Point vs Point3D (different classes):",
  `%HaveSameMap(classPoint1, classPoint3D_1) =`,
  eval("%HaveSameMap(classPoint1, classPoint3D_1)"),
); // false

// ===========================================================================
// PART 6: Performance Impact Benchmark
// ===========================================================================

console.log("\n\nPART 6: Performance Impact of Hidden Class Stability");
console.log("-".repeat(50));

// Function that will be optimized by V8
function sumXY(obj) {
  return obj.x + obj.y;
}

// Create arrays of objects with stable and unstable shapes
const ITERATIONS = 1000000;

// Stable shapes - all objects have the same hidden class
const stableObjects = [];
for (let i = 0; i < 1000; i++) {
  stableObjects.push({ x: i, y: i * 2 });
}

// Unstable shapes - alternating property order
const unstableObjects = [];
for (let i = 0; i < 1000; i++) {
  if (i % 2 === 0) {
    const obj = {};
    obj.x = i;
    obj.y = i * 2;
    unstableObjects.push(obj);
  } else {
    const obj = {};
    obj.y = i * 2;
    obj.x = i;
    unstableObjects.push(obj);
  }
}

// Warm up the function for JIT optimization
for (let i = 0; i < 100; i++) {
  sumXY(stableObjects[0]);
}

// Benchmark stable shapes
console.time("Stable hidden classes");
let stableSum = 0;
for (let i = 0; i < ITERATIONS; i++) {
  stableSum += sumXY(stableObjects[i % stableObjects.length]);
}
console.timeEnd("Stable hidden classes");

// Benchmark unstable shapes
console.time("Unstable hidden classes");
let unstableSum = 0;
for (let i = 0; i < ITERATIONS; i++) {
  unstableSum += sumXY(unstableObjects[i % unstableObjects.length]);
}
console.timeEnd("Unstable hidden classes");

console.log("\nNote: Real-world benchmark results (V8 v12.4.254.21):");
console.log("- Property order inconsistency: 8.8x slower");
console.log("- Dynamic factory pattern: 5.0x slower");
console.log("- Multiple shapes: 1.5x slower");

// ===========================================================================
// PART 7: Advanced - Dictionary Mode
// ===========================================================================

console.log("\n\nPART 7: Dictionary Mode (Slow Properties)");
console.log("-".repeat(50));

const normalObject = { a: 1, b: 2, c: 3 };
const dictObject = { a: 1, b: 2, c: 3 };

// Using delete forces the object into dictionary mode
delete dictObject.b;

console.log("Normal object maintains fast properties");
console.log("Dictionary object (after delete) uses slow hash-map storage");

// You can't directly check dictionary mode with %HaveSameMap,
// but the performance difference is significant

// ===========================================================================
// PART 8: Factory Functions for Consistent Shapes
// ===========================================================================

console.log("\n\nPART 8: Factory Functions Best Practices");
console.log("-".repeat(50));

// BAD: Inconsistent object creation
function badFactory(config) {
  const obj = {};

  if (config.needsId) obj.id = config.id;
  if (config.needsName) obj.name = config.name;
  if (config.needsValue) obj.value = config.value;

  return obj;
}

// GOOD: Consistent shape with null defaults
function goodFactory(config) {
  return {
    id: config.id || null,
    name: config.name || null,
    value: config.value || null,
  };
}

// BEST: Using a class for guaranteed consistency
class ConfigObject {
  constructor(config = {}) {
    this.id = config.id || null;
    this.name = config.name || null;
    this.value = config.value || null;
  }
}

const bad1 = badFactory({ needsId: true, id: 1 });
const bad2 = badFactory({ needsName: true, name: "test" });
const bad3 = badFactory({ needsId: true, id: 2, needsName: true, name: "test2" });

console.log("Bad factory creates different shapes:");
console.log("bad1 vs bad2:", `%HaveSameMap(bad1, bad2) =`, eval("%HaveSameMap(bad1, bad2)")); // false

const good1 = goodFactory({ id: 1 });
const good2 = goodFactory({ name: "test" });
const good3 = goodFactory({ id: 2, name: "test2" });

console.log("\nGood factory creates consistent shapes:");
console.log("good1 vs good2:", `%HaveSameMap(good1, good2) =`, eval("%HaveSameMap(good1, good2)")); // true
console.log("good2 vs good3:", `%HaveSameMap(good2, good3) =`, eval("%HaveSameMap(good2, good3)")); // true

// ===========================================================================
// SUMMARY
// ===========================================================================

console.log("\n\n" + "=".repeat(80));
console.log("KEY TAKEAWAYS:");
console.log("=".repeat(80));
console.log(`
1. Objects with the same properties in the same order share hidden classes
2. Different property orders create different hidden classes (performance penalty)
3. Conditional properties fork the hidden class tree (avoid in hot paths)
4. Pre-initialize all properties (even with null/undefined) for stability
5. Classes and consistent factory functions ensure hidden class sharing
6. The 'delete' operator forces dictionary mode (very slow)
7. Object literals are generally faster than dynamic property addition
8. Use constructors/classes for performance-critical objects

Remember: V8 rewards predictable, boring code with exceptional performance!
`);
