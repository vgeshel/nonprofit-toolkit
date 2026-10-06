# Test-Driven Development (TDD)

TDD is mandatory. The test is the spec. It is the only spec.

## Red → Green → Refactor

1. **RED**: Write a failing test first. The test defines what the code should do.
2. **GREEN**: Write the minimum code to make the test pass.
3. **REFACTOR**: Clean up the code while keeping tests green.

Without a test, you don't know what the code is supposed to do.

## Coverage Goal: 100%

- Every function must have tests
- Every code path must be exercised
- Every edge case must be covered

## Test Quality Requirements

Tests must be thorough and meaningful:

- **Test with realistic inputs**, not just trivial examples
- **Verify specific results**, not just "no exception thrown"
- **Assert on actual values**: Check that function returns `[1, 2, 3]`, not just that it returns an array
- **Test error cases**: Verify the right error is thrown with the right message
- **Test edge cases**: Empty inputs, null values, boundary conditions
- **Test all code paths**: Both branches of every if statement

Assert on concrete values, not on the absence of a throw: `expect(result).toEqual({ items: [2, 4, 6], count: 3 })`, never `expect(() => fn()).not.toThrow()`.
