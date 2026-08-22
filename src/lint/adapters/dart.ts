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
//   LAST_CHANGE: [separate localSymbols (all top-level declarations) from exports (public-only, non-underscore)]
// END_CHANGE_SUMMARY

// Ported from the fork/v3 adapter. localSymbols captures every top-level
// declaration the regex extraction finds, regardless of visibility (private
// starts with `_`); exports keeps only the non-private subset. localSymbols
// is always a superset of exports.
//
// No external dart binary invocation: analysis runs fully in-process against
// the source text, eliminating the prior subprocess-spawn invocation surface.

import path from "node:path";

import type { LanguageAdapter, LanguageAnalysis } from "../types";
import { buildLineDepths } from "./source-scan";

const DART_EXTENSIONS = new Set([".dart"]);

const TEST_IMPORT_RE = /import\s+['"]package:(test|flutter_test)\//;
const TEST_CALL_RE = /\b(test|group|testWidgets)\s*\(/;

// Matches top-level declarations, public or private (private starts with `_`).
// Captures: class (with Dart 3 modifiers), mixin, enum, extension, extension type,
// typedef. Visibility is decided by the caller (recordDeclaration), not by this regex.
//
// Six alternatives, tried in order, each with its own capture group (only one group is
// ever populated per match — see matchTopLevelDeclName):
//   1. class, with the fixed-order Dart 3 modifier prefix:
//      abstract? (base|interface|final|sealed)? mixin? class Name
//      Covers plain `class`, `abstract class`, `base/final/interface/sealed class`,
//      `abstract base/final/interface class`, and `mixin class` (a class declaration,
//      name follows `class` not `mixin`).
//   2. mixin declaration (not `mixin class`): base? mixin Name
//   3. enum Name
//   4. extension type (Dart 3.3), tried before the bare `extension` alternative so
//      `type` is never mistaken for the extension's name: extension type const? Name
//   5. bare extension: extension Name — negative lookahead excludes `on`, since
//      `extension on Type {}` (unnamed extension) declares no symbol.
//   6. typedef Name
const TOP_LEVEL_DECL_RE =
  /^(?:abstract\s+)?(?:(?:base|interface|final|sealed)\s+)?(?:mixin\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)|^(?:base\s+)?mixin\s+([A-Za-z_][A-Za-z0-9_]*)|^enum\s+([A-Za-z_][A-Za-z0-9_]*)|^extension\s+type\s+(?:const\s+)?([A-Za-z_][A-Za-z0-9_]*)|^extension\s+(?!on\b)([A-Za-z_][A-Za-z0-9_]*)|^typedef\s+([A-Za-z_][A-Za-z0-9_]*)/;

// Returns the captured declaration name from TOP_LEVEL_DECL_RE, whichever of its six
// alternatives matched (only one capture group is populated per match).
function matchTopLevelDeclName(line: string): string | null {
  const m = TOP_LEVEL_DECL_RE.exec(line);
  if (!m) return null;
  for (let i = 1; i < m.length; i++) {
    if (m[i] !== undefined) return m[i];
  }
  return null;
}

// Top-level function/constructor declaration: requires an explicit return-type token before the name.
// The prefix (return type) is REQUIRED (no ?) to distinguish declarations from bare call expressions.
// Captures: group(1)=return-type tokens, group(2)=function name.
// The return-type class accepts `(` `)` so a return type that is itself a function type
// ("ErrorReporter? Function()? _tryGetIt(") is consumed by group(1) and the REAL declaration
// name is captured — without it, "Function" was read as the name and exported as a phantom.
// Examples that match: "void main(", "Future<int> f(", "String greet(", "set x(",
// "ErrorReporter? Function()? _tryGetIt(" (name = _tryGetIt).
// Examples that do NOT match: "mySideEffect(" (no return-type prefix before the name).
// For rare legacy top-level functions that omit the return type, the body-indicator fallback
// (TOP_LEVEL_FUNC_BODY_RE) catches declarations with a `{` or `=>` body marker on the same line.
const TOP_LEVEL_FUNC_RE = /^([\w<>\[\]?,\s()]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

// Fallback for omitted-return-type declarations: requires a body indicator on the same line.
// Matches: "name(...) {", "name(...) =>", "name(...) async", "name(...) sync*".
// Does NOT match bare calls: "name();" or "name(arg);" which have no body.
const TOP_LEVEL_FUNC_BODY_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(.*\)\s*(async|sync\*|{|=>)/;

// Top-level var declaration: "final|const|var [type] name =|;". The optional type
// class accepts `(` `)` so a function-typed type ("Map<String, Widget Function(...)>")
// is consumed by the type group and the real declaration name is captured.
const TOP_LEVEL_VAR_RE =
  /^(?:final|const|var|late\s+final|late\s+var)\s+(?:[\w<>\[\]?,\s()]*?\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=;]/;

// Top-level var declaration split across two physical lines: the first line carries
// only the type (no `=`/`;`), the second carries "name =" / "name;":
//   final Map<String, Widget Function(ChatWidgetCardMessage message)>
//       aiWidgetCardBuilders = {
// TOP_LEVEL_VAR_RE cannot match the type-only line, and without this branch the
// func pattern below would read the type's trailing "Function(" as a declaration
// name and export a phantom `Function`.
const TOP_LEVEL_VAR_HEADER_RE =
  /^(?:final|const|var|late\s+final|late\s+var)\s+[\w<>\[\]?,\s()]+$/;
// The continuation line carrying the declaration name: "name =" or "name;".
const TOP_LEVEL_VAR_NAME_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*[=;]/;

// Top-level getter: "<type> get <name>" at depth 0.
// Examples: "int get answer =>", "List<String> get names =>", "String get id {"
const TOP_LEVEL_GETTER_RE = /^[\w<>\[\]?,\s]+\s+get\s+([A-Za-z_][A-Za-z0-9_]*)\s*[({=>]/;

// export directive: "export 'path';" or "export 'path' show A, B;" or "export 'path' hide ...;"
const EXPORT_DIRECTIVE_RE = /^export\s+['"][^'"]+['"]\s*(show\s+([^;]+?)\s*;|hide\s+[^;]+;|;)/;

const ANNOTATION_RE = /^\s*@/;
const COMMENT_RE = /^\s*(\/\/|\/\*|\*)/;
// Matches import/library/part directives (export is handled separately before this filter).
const IMPORT_ONLY_RE = /^\s*(import|library|part)\s/;

// NIT-6: expanded keyword guard for top-level func regex
// `Function` is added as defense-in-depth: a function-type keyword must never be
// treated as a declaration name (a return type containing "Function(" previously
// landed a phantom `Function` in exports). A real top-level symbol named
// `Function` would shadow the dart:core type and does not occur in practice; the
// regex fixes above already capture the real declaration name in the shapes this
// guard protects against, so nothing legitimate is dropped.
const DART_KEYWORD_GUARD = new Set([
  "if", "for", "while", "return", "switch", "catch", "await", "assert", "sync", "yield",
  "get", "set", "Function",
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
  localSymbols: Set<string>;
  hasWildcardReExport: boolean;
  directReExportCount: number;
}

// Records `name` in localSymbols always, and in exports only when it is not
// private (does not start with `_`).
function recordDeclaration(exports: Set<string>, localSymbols: Set<string>, name: string) {
  localSymbols.add(name);
  if (!name.startsWith("_")) {
    exports.add(name);
  }
}

function extractDartExports(text: string): ExtractionResult {
  const exports = new Set<string>();
  const localSymbols = new Set<string>();
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
              // Re-exported names have no local declaration in this file, but
              // localSymbols must stay a superset of exports.
              localSymbols.add(name);
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

    const declName = matchTopLevelDeclName(line);
    if (declName) {
      recordDeclaration(exports, localSymbols, declName);
      continue;
    }

    const varMatch = TOP_LEVEL_VAR_RE.exec(line);
    if (varMatch) {
      recordDeclaration(exports, localSymbols, varMatch[1]);
      continue;
    }

    // Multi-line var declaration: a type-only line at depth 0 (no `=`/`;`) continues
    // onto the next physical line, which carries "name =" / "name;". Recognized
    // before the func pattern so the type line's inner "Function(" is never read as
    // a declaration name. The name line is consumed here and skipped by the loop.
    if (TOP_LEVEL_VAR_HEADER_RE.test(line)) {
      const nameMatch = TOP_LEVEL_VAR_NAME_RE.exec(lines[idx + 1]?.trim() ?? "");
      if (nameMatch) {
        recordDeclaration(exports, localSymbols, nameMatch[1]);
        idx++;
      }
      continue;
    }

    // Getter pattern: "<type> get <name> ..." — must check before func pattern to avoid
    // TOP_LEVEL_FUNC_RE matching the type-prefix part of a getter line.
    if (/\bget\s+[A-Za-z]/.test(line)) {
      const getterMatch = TOP_LEVEL_GETTER_RE.exec(line);
      if (getterMatch) {
        const name = getterMatch[1];
        if (!DART_KEYWORD_GUARD.has(name)) {
          recordDeclaration(exports, localSymbols, name);
        }
        continue;
      }
    }

    // Primary func pattern: requires explicit return-type prefix.
    const funcMatch = TOP_LEVEL_FUNC_RE.exec(line);
    if (funcMatch) {
      const name = funcMatch[2];
      if (!DART_KEYWORD_GUARD.has(name)) {
        recordDeclaration(exports, localSymbols, name);
      }
      continue;
    }

    // Fallback: no return type but has a body indicator — still a declaration, not a call.
    const bodyMatch = TOP_LEVEL_FUNC_BODY_RE.exec(line);
    if (bodyMatch) {
      const name = bodyMatch[1];
      if (!DART_KEYWORD_GUARD.has(name)) {
        recordDeclaration(exports, localSymbols, name);
      }
    }
  }

  return { exports, localSymbols, hasWildcardReExport, directReExportCount };
}

export function createDartAdapter(): LanguageAdapter {
  return {
    id: "dart",
    supports(filePath) {
      return DART_EXTENSIONS.has(path.extname(filePath));
    },
    analyze(filePath, text) {
      const { exports, localSymbols, hasWildcardReExport, directReExportCount } = extractDartExports(text);
      const usesTestFramework = isTestFile(filePath, text);

      const analysis: LanguageAnalysis = {
        adapterId: "dart",
        exports,
        valueExports: new Set(exports),
        typeExports: new Set<string>(),
        localSymbols,
        exportConfidence: "heuristic",
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
