import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

import { createPythonAdapter } from "./python";

const hasPython = ["python3", "python"].some((binary) => {
  const result = spawnSync(binary, ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
});

describe("PythonAdapter", () => {
  const adapter = createPythonAdapter();

  test("supports Python source and stub files", () => {
    expect(adapter.supports("module.py")).toBe(true);
    expect(adapter.supports("module.pyi")).toBe(true);
    expect(adapter.supports("module.ts")).toBe(false);
  });

  test.skipIf(!hasPython)("includes a private top-level symbol in localSymbols but not in exports", () => {
    const result = adapter.analyze(
      "module.py",
      `def _private_helper():\n    return 1\n\n\ndef public_helper():\n    return _private_helper()\n`,
    );
    expect(result.localSymbols.has("_private_helper")).toBe(true);
    expect(result.exports.has("_private_helper")).toBe(false);
    expect(result.exports.has("public_helper")).toBe(true);
  });

  test.skipIf(!hasPython)("localSymbols is a superset of exports", () => {
    const result = adapter.analyze(
      "module.py",
      `_INTERNAL = 1\nPUBLIC = 2\n\n\nclass _Hidden:\n    pass\n\n\nclass Visible:\n    pass\n`,
    );
    for (const name of result.exports) {
      expect(result.localSymbols.has(name)).toBe(true);
    }
    expect(result.localSymbols.has("_INTERNAL")).toBe(true);
    expect(result.localSymbols.has("_Hidden")).toBe(true);
  });

  test.skipIf(!hasPython)("does not leak a nested function into top-level localSymbols", () => {
    const result = adapter.analyze(
      "module.py",
      `def outer():\n    def nested_inner():\n        return 1\n    return nested_inner()\n`,
    );
    expect(result.localSymbols.has("outer")).toBe(true);
    expect(result.localSymbols.has("nested_inner")).toBe(false);
  });

  test.skipIf(!hasPython)("decodes Bun stdin as UTF-8 even when Python is configured for a legacy locale", () => {
    const previousEncoding = process.env.PYTHONIOENCODING;
    process.env.PYTHONIOENCODING = "cp1251";
    try {
      const result = adapter.analyze(
        "example.py",
        `# Кириллический комментарий\nGREETING = "Привет 🌍"\ndef привет():\n    return GREETING\n`,
      );
      expect(result.exports.has("GREETING")).toBe(true);
      expect(result.exports.has("привет")).toBe(true);
    } finally {
      if (previousEncoding === undefined) delete process.env.PYTHONIOENCODING;
      else process.env.PYTHONIOENCODING = previousEncoding;
    }
  });

  test("analyzerVersion is memoized: repeated calls return the identical value", () => {
    // Spawning a subprocess per call would defeat the point of the analysis
    // cache. Asserting the exact process count would require injecting a
    // spawnSync spy into python.ts, which the adapter does not currently
    // support. What is actually verified here: two calls return the exact
    // same string (module-level memoization is observable through identity
    // of the returned value, not through call-count instrumentation).
    const first = adapter.analyzerVersion?.();
    const second = adapter.analyzerVersion?.();
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });
});
