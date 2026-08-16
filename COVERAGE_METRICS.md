# Coverage Metrics

This file tracks the test coverage metrics for the Boudreaux project.

## Current Coverage Summary

| Metric     | Coverage |
| ---------- | -------- |
| Statements | 100.00%  |
| Branches   | 100.00%  |
| Functions  | 100.00%  |
| Lines      | 100.00%  |

**Last Updated:** 2026-08-16

---

## Coverage History

| Date       | Statements | Branches | Functions | Lines  | Notes            |
| ---------- | ---------- | -------- | --------- | ------ | ---------------- |
| 2026-08-16 | 95.00%     | 95.00%   | 95.00%    | 95.00% | Updated baseline |

---

## Coverage Targets

- **Minimum Target:** 90-95%+ on all testable files except for branches, which should be at least 95%+.
- **Ideal Target:** 100% on all testable files, including branches.
- **Current Status:** new project

### Coverage Regression Policy

The project uses automated coverage regression checking during builds:

- **Tolerance:** Up to **2% decrease** is permitted for any metric
- **Condition:** The metric must remain **above the configured threshold**
- **Thresholds:**
  - Statements: 95%
  - Branches: 95%
  - Functions: 95%
  - Lines: 95%

**Examples:**

- ✅ Statements: 97% → 95.5% (within 2% tolerance, above 95% threshold)
- ❌ Statements: 97% → 94.5% (within 2% tolerance, but **below** 95% threshold)
- ❌ Statements: 97% → 94% (exceeds 2% tolerance)

This policy allows for minor coverage decreases due to new code additions while maintaining overall quality standards.

---

## How to Update

Run the following command to generate a new coverage report:

```bash
pnpm run test:coverage
```

The coverage report will be generated in the `coverage/` directory. Update this file with the new metrics from the summary output.

---

## Excluded Files

The following are excluded from coverage as per project guidelines:

- Configuration files
- Types and interfaces (`.d.ts` files)
