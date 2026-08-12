// START_MODULE_CONTRACT
//   PURPOSE: Language adapter for Dart source files.
//   SCOPE: Heuristic export analysis via regex; test-role detection.
//   DEPENDS: types, source-scan
//   LINKS: M-LINT-ADAPTERS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   createDartAdapter - Factory for the Dart LanguageAdapter.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.4.0 - fix TOP_LEVEL_FUNC_RE call over-capture; add getter pattern; parse export directives]
// END_CHANGE_SUMMARY

import path from "node:path";

import type { LanguageAdapter, LanguageAnalysis } from "../types";
import { buildLineDepths } from "./source-scan";

const DART_EXTENSIONS = new Set([".dart"]);

const TEST_IMPORT_RE = /import\s+['"]package:(test|flutter_test)\//;
const TEST_CALL_RE = /\b(test|group|testWidgets)\s*\(/;

// Matches top-level declarations that are NOT private (not starting with _).
// Captures: class, mixin, enum, extension, typedef.
const TOP_LEVEL_DECL_RE =
  /^(?:abstract\s+)?(?:class|mixin|enum|extension|typedef)\s+([A-Za-z][A-Za-z0-9_]*)/;

// Top-level function/constructor declaration: requires an explicit return-type token before the name.
// The prefix (return type) is REQUIRED (no ?) to distinguish declarations from bare call expressions.
// Captures: group(1)=return-type tokens, group(2)=function name.
// Examples that match: "void main(", "Future<int> f(", "String greet(", "set x(",
// Examples that do NOT match: "mySideEffect(" (no return-type prefix before the name).
// For rare legacy top-level functions that omit the return type, the body-indicator fallback
// (TOP_LEVEL_FUNC_BODY_RE) catches declarations with a `{` or `=>` body marker on the same line.
const TOP_LEVEL_FUNC_RE = /^([\w<>\[\]?,\s]+)\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/;

// Fallback for omitted-return-type declarations: requires a body indicator on the same line.
// Matches: "name(...) {", "name(...) =>", "name(...) async", "name(...) sync*".
// Does NOT match bare calls: "name();" or "name(arg);" which have no body.
const TOP_LEVEL_FUNC_BODY_RE = /^([A-Za-z][A-Za-z0-9_]*)\s*\(.*\)\s*(async|sync\*|{|=>)/;

const TOP_LEVEL_VAR_RE =
  /^(?:final|const|var|late\s+final|late\s+var)\s+(?:[\w<>\[\]?,\s]*?\s+)?([A-Za-z][A-Za-z0-9_]*)\s*[=;]/;

// Top-level getter: "<type> get <name>" at depth 0.
// Examples: "int get answer =>", "List<String> get names =>", "String get id {"
const TOP_LEVEL_GETTER_RE = /^[\w<>\[\]?,\s]+\s+get\s+([A-Za-z][A-Za-z0-9_]*)\s*[({=>]/;

// export directive: "export 'path';" or "export 'path' show A, B;" or "export 'path' hide ...;"
const EXPORT_DIRECTIVE_RE = /^export\s+['"][^'"]+['"]\s*(show\s+([^;]+?)\s*;|hide\s+[^;]+;|;)/;

const ANNOTATION_RE = /^\s*@/;
const COMMENT_RE = /^\s*(\/\/|\/\*|\*)/;
// Matches import/library/part directives (export is handled separately before this filter).
const IMPORT_ONLY_RE = /^\s*(import|library|part)\s/;

// NIT-6: expanded keyword guard for top-level func regex
const DART_KEYWORD_GUARD = new Set([
  "if", "for", "while", "return", "switch", "catch", "await", "assert", "sync", "yield",
  "get", "set",
]);

interface ExportDirectiveResult {
  hasWildcard: boolean;
  namedExports: string[];
}

function parseExportDirective(line: string): ExportDirectiveResult | null {
  const m = EXPORT_DIRECTIVE_RE.exec(line);
  if (!m) return null;

  const suffix = m[1]?.trim() ?? "";

  if (suffix === ";") {
    // bare export — wildcard re-export
    return { hasWildcard: true, namedExports: [] };
  }
  if (suffix.startsWith("hide")) {
    // hide means we can't enumerate what's exported — wildcard
    return { hasWildcard: true, namedExports: [] };
  }
  if (suffix.startsWith("show") && m[2]) {
    // show A, B, C — enumerate named exports
    const names = m[2].split(",").map((s) => s.trim()).filter(Boolean);
    return { hasWildcard: false, namedExports: names };
  }

  return null;
}

function isTestFile(filePath: string, text: string) {
  if (path.basename(filePath).endsWith("_test.dart")) {
    return true;
  }
  return TEST_IMPORT_RE.test(text) || TEST_CALL_RE.test(text);
}

interface ExtractionResult {
  exports: Set<string>;
  hasWildcardReExport: boolean;
  directReExportCount: number;
}

function extractDartExports(text: string): ExtractionResult {
  const exports = new Set<string>();
  let hasWildcardReExport = false;
  let directReExportCount = 0;

  const lines = text.split("\n");
  const lineDepths = buildLineDepths(text);

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const depthAtLineStart = lineDepths[idx] ?? 0;

    const line = raw.trim();
    if (!line || COMMENT_RE.test(line) || ANNOTATION_RE.test(line)) {
      continue;
    }

    // BUG-3: only top-level declarations (depth 0 at start of line).
    if (depthAtLineStart !== 0) {
      continue;
    }

    // Handle export directives before the general import/export skip.
    if (/^export\s/.test(line)) {
      const result = parseExportDirective(line);
      if (result) {
        if (result.hasWildcard) {
          hasWildcardReExport = true;
          directReExportCount++;
        } else {
          for (const name of result.namedExports) {
            if (name && !name.startsWith("_")) {
              exports.add(name);
            }
          }
          directReExportCount++;
        }
      }
      continue;
    }

    // Skip import/library/part directives (export already handled above).
    if (IMPORT_ONLY_RE.test(line)) {
      continue;
    }

    const declMatch = TOP_LEVEL_DECL_RE.exec(line);
    if (declMatch) {
      const name = declMatch[1];
      if (!name.startsWith("_")) {
        exports.add(name);
      }
      continue;
    }

    const varMatch = TOP_LEVEL_VAR_RE.exec(line);
    if (varMatch) {
      const name = varMatch[1];
      if (!name.startsWith("_")) {
        exports.add(name);
      }
      continue;
    }

    // Getter pattern: "<type> get <name> ..." — must check before func pattern to avoid
    // TOP_LEVEL_FUNC_RE matching the type-prefix part of a getter line.
    if (/\bget\s+[A-Za-z]/.test(line)) {
      const getterMatch = TOP_LEVEL_GETTER_RE.exec(line);
      if (getterMatch) {
        const name = getterMatch[1];
        if (!name.startsWith("_") && !DART_KEYWORD_GUARD.has(name)) {
          exports.add(name);
        }
        continue;
      }
    }

    // Primary func pattern: requires explicit return-type prefix.
    const funcMatch = TOP_LEVEL_FUNC_RE.exec(line);
    if (funcMatch) {
      const name = funcMatch[2];
      if (!name.startsWith("_") && !DART_KEYWORD_GUARD.has(name)) {
        exports.add(name);
      }
      continue;
    }

    // Fallback: no return type but has a body indicator — still a declaration, not a call.
    const bodyMatch = TOP_LEVEL_FUNC_BODY_RE.exec(line);
    if (bodyMatch) {
      const name = bodyMatch[1];
      if (!name.startsWith("_") && !DART_KEYWORD_GUARD.has(name)) {
        exports.add(name);
      }
    }
  }

  return { exports, hasWildcardReExport, directReExportCount };
}

export function createDartAdapter(): LanguageAdapter {
  return {
    id: "dart",
    supports(filePath) {
      return DART_EXTENSIONS.has(path.extname(filePath));
    },
    analyze(filePath, text) {
      const { exports, hasWildcardReExport, directReExportCount } = extractDartExports(text);
      const usesTestFramework = isTestFile(filePath, text);

      const analysis: LanguageAnalysis = {
        adapterId: "dart",
        exports,
        valueExports: new Set(exports),
        typeExports: new Set<string>(),
        exportConfidence: "heuristic",
        exportsComplete: false,
        hasDefaultExport: false,
        hasWildcardReExport,
        hasMainEntrypoint: /\bvoid\s+main\s*\(/.test(text),
        directReExportCount,
        localExportCount: exports.size,
        localImplementationCount: exports.size,
        usesTestFramework,
      };

      return analysis;
    },
  };
}
