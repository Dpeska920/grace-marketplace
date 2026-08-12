// Language adapter for Kotlin (.kt) and Kotlin Script (.kts) files.
// Heuristic export analysis via regex; test-role and script-role detection.
//
// Ported from the fork/v3 adapter. localSymbols captures every top-level
// declaration the regex extraction finds, including ones marked
// private/internal/protected; exports keeps only the public subset (default
// visibility, or an explicit `public` modifier). localSymbols is always a
// superset of exports.

import path from "node:path";

import type { LanguageAdapter, LanguageAnalysis } from "../types";
import { buildLineDepths } from "./source-scan";

const KOTLIN_EXTENSIONS = new Set([".kt", ".kts"]);

// BUG-1 fix: match private/internal/protected only at the START of a declaration
// (leading modifiers), not anywhere in the line (e.g. constructor parameters).
const LEADING_PRIVATE_RE = /^(?:public\s+|open\s+|abstract\s+|sealed\s+|data\s+|inline\s+|value\s+|override\s+)*(private|internal|protected)\b/;

const TEST_IMPORT_RE = /import\s+(org\.junit|kotlin\.test|io\.kotest|io\.mockk)/;
const TEST_ANNOTATION_RE = /@Test\b/;

// Top-level Kotlin declaration patterns.
// FIX-D: added const, expect, actual to modifier alternation for const val / KMP expect-actual.
// Named companion object: "companion object Factory" — captured by `object` keyword + name group.
// Anonymous companion object: "companion object {" — no name, skipped (no symbol to export).
// FIX-EXT-1: annotation added to modifier alternation so `annotation class Marker` is captured.
// FIX-EXT-2: after `fun` keyword, allow optional type-param clause `<...>` (generic free functions).
// FIX-EXT-3: after optional type params, allow optional receiver prefix `ReceiverType<...>.`
//   so that extension functions export the function name, not the receiver type.
// FIX-NESTED-GENERIC: the type-param clause after `fun` uses a balanced pattern up to 2 nesting
//   levels so that `<T : Comparable<T>>` and `<T : List<Map<K,V>>>` are consumed correctly.
//   Old `[^>]*` stopped at the first `>`, leaving a stray `>` that broke the name match.
const NESTED_ANGLE =
  "<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>";
const DECL_RE = new RegExp(
  "^(?:(?:(?:public|internal|private|protected|open|abstract|sealed|data|inner|inline|value|companion|override|tailrec|suspend|infix|operator|external|const|expect|actual|annotation)\\s+)*)" +
  "(class|object|interface|fun|val|var|enum\\s+class|typealias)\\s+" +
  `(?:${NESTED_ANGLE}\\s+)?` +
  "(?:[A-Za-z_][A-Za-z0-9_<>, *]*\\.\\s*)?" +
  "([A-Za-z_][A-Za-z0-9_]*)",
);

const COMMENT_RE = /^\s*(\/\/|\/\*|\*)/;
// Annotation ident: @qualified.Name — no args or balanced-paren args follow
const ANNOTATION_IDENT_RE = /^@[A-Za-z_][A-Za-z0-9_.]*/;

// FIX-A: strip ALL leading annotations (possibly with nested parens) from a line.
// Consumes: optional whitespace, @Ident, optional balanced-paren argument block, repeat.
// Returns the remainder after all annotations, or empty string if nothing remains.
function stripLeadingAnnotations(line: string): string {
  let pos = 0;
  const len = line.length;

  while (pos < len) {
    // Skip leading whitespace
    while (pos < len && line[pos] === " ") pos++;
    if (pos >= len || line[pos] !== "@") break;

    // Match @Ident
    const identMatch = ANNOTATION_IDENT_RE.exec(line.slice(pos));
    if (!identMatch) break;
    pos += identMatch[0].length;

    // Optionally consume balanced parens
    if (pos < len && line[pos] === "(") {
      let depth = 0;
      let inStr = false;
      let strChar = "";
      while (pos < len) {
        const ch = line[pos];
        if (inStr) {
          if (ch === "\\" && pos + 1 < len) { pos += 2; continue; }
          if (ch === strChar) inStr = false;
        } else if (ch === '"' || ch === "'") {
          inStr = true;
          strChar = ch;
        } else if (ch === "(") {
          depth++;
        } else if (ch === ")") {
          depth--;
          if (depth === 0) { pos++; break; }
        }
        pos++;
      }
    }
  }

  return line.slice(pos);
}

// TYPE_KEYWORDS: Kotlin declaration kinds that are pure type-only abstractions.
// `interface`, `typealias`, and `sealed interface` (keyword=`interface`) qualify.
// `annotation class` matches keyword=`class` but has `annotation` in its modifier prefix —
// detected by checking the effective line for the `annotation` modifier before `class`.
const KOTLIN_TYPE_KEYWORDS = new Set(["interface", "typealias"]);

// Detect `annotation class Foo` — after annotation-stripping the effective line still starts
// with the `annotation` modifier before `class`.
const ANNOTATION_CLASS_PREFIX_RE = /^(?:(?:public|open|abstract|sealed|data|inline|value|companion|override|tailrec|suspend|infix|operator|external|const|expect|actual)\s+)*annotation\s+class\b/;

type KotlinExportSets = {
  exports: Set<string>;
  valueExports: Set<string>;
  typeExports: Set<string>;
  localSymbols: Set<string>;
};

function extractKotlinExports(text: string): KotlinExportSets {
  const exports = new Set<string>();
  const valueExports = new Set<string>();
  const typeExports = new Set<string>();
  const localSymbols = new Set<string>();
  const lines = text.split("\n");
  const lineDepths = buildLineDepths(text);

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const depthAtLineStart = lineDepths[idx] ?? 0;
    const line = raw.trim();

    if (!line || COMMENT_RE.test(line)) {
      continue;
    }

    // FIX-A: strip leading same-line annotations (with balanced nested parens).
    // If the line has ONLY annotations (no trailing declaration), skip it.
    const stripped = stripLeadingAnnotations(line).trim();
    if (!stripped) {
      // Pure annotation line — no declaration follows on this line
      continue;
    }
    const effectiveLine = stripped;

    // BUG-3: only consider top-level declarations (depth 0 at start of line).
    if (depthAtLineStart !== 0) {
      continue;
    }

    // BUG-1 fix: check visibility modifier only at the head of the effective declaration.
    // Use effectiveLine (annotations stripped) so @private class X is not misread.
    // private/internal/protected declarations still land in localSymbols below —
    // this only gates whether the name is also treated as public exported surface.
    const isRestrictedVisibility = LEADING_PRIVATE_RE.test(effectiveLine);

    const match = DECL_RE.exec(effectiveLine);
    if (match) {
      const keyword = match[1]!; // e.g. "interface", "class", "fun", "typealias", "enum class"
      const name = match[2];
      if (name) {
        localSymbols.add(name);
        if (isRestrictedVisibility) {
          continue;
        }
        exports.add(name);
        // Classify: interface, typealias, sealed interface → TYPE
        // annotation class → TYPE (annotation modifier + class keyword)
        // Everything else (class, data class, enum class, object, fun, val, var, …) → VALUE
        const isTypeKind =
          KOTLIN_TYPE_KEYWORDS.has(keyword) ||
          ANNOTATION_CLASS_PREFIX_RE.test(effectiveLine);
        if (isTypeKind) {
          typeExports.add(name);
        } else {
          valueExports.add(name);
        }
      }
    }
  }

  return { exports, valueExports, typeExports, localSymbols };
}

function isTestFile(text: string): boolean {
  return TEST_IMPORT_RE.test(text) || TEST_ANNOTATION_RE.test(text);
}

function isScriptOrMain(filePath: string, text: string): boolean {
  if (path.extname(filePath) === ".kts") {
    return true;
  }
  return /\bfun\s+main\s*\(/.test(text);
}

export function createKotlinAdapter(): LanguageAdapter {
  return {
    id: "kotlin",
    supports(filePath) {
      return KOTLIN_EXTENSIONS.has(path.extname(filePath));
    },
    analyze(filePath, text) {
      const { exports, valueExports, typeExports, localSymbols } = extractKotlinExports(text);
      const usesTestFramework = isTestFile(text);
      const hasMainEntrypoint = isScriptOrMain(filePath, text);

      const analysis: LanguageAnalysis = {
        adapterId: "kotlin",
        exports,
        valueExports,
        typeExports,
        localSymbols,
        exportConfidence: "heuristic",
        hasDefaultExport: false,
        hasWildcardReExport: false,
        hasMainEntrypoint,
        directReExportCount: 0,
        localExportCount: exports.size,
        localImplementationCount: exports.size,
        usesTestFramework,
      };

      return analysis;
    },
  };
}
