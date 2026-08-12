import { createDartAdapter } from "./lint/adapters/dart";
import { createKotlinAdapter } from "./lint/adapters/kotlin";
import { createPythonAdapter } from "./lint/adapters/python";
import { createSwiftAdapter } from "./lint/adapters/swift";
import { createTypeScriptAdapter } from "./lint/adapters/typescript";
import { createVueAdapter } from "./lint/adapters/vue";
import type { LanguageAdapter } from "./lint/types";

/**
 * File extensions that GRACE recognizes as code files.
 * When adding a new language, add its extension(s) here.
 */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".pyi",
  ".go",
  ".java",
  ".kt", ".kts",
  ".rs",
  ".rb",
  ".php",
  ".swift",
  ".scala",
  ".sql",
  ".sh", ".bash", ".zsh",
  ".clj", ".cljs", ".cljc",
  ".dart",
  ".vue",
]);

/** Extensions with a registered language adapter and export/local analysis support. */
export const ADAPTER_BACKED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".pyi", ".dart",
  ".kt", ".kts",
  ".swift",
  ".vue",
]);

/**
 * Language adapters registered with the linter, in order.
 * The first adapter whose supports() returns true for a given file is used.
 * Add new adapter factories here when adding language support.
 */
export const LANGUAGE_ADAPTERS: readonly LanguageAdapter[] = [
  createTypeScriptAdapter(),
  createPythonAdapter(),
  createDartAdapter(),
  createKotlinAdapter(),
  createSwiftAdapter(),
  createVueAdapter(),
];
