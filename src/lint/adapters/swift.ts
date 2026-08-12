// Language adapter for Swift source files.
// Heuristic export analysis for public/open declarations; test-role detection.
//
// Ported from the fork/v3 adapter. Everything the regex extraction finds is
// already gated behind an explicit public/open modifier (or inherited from a
// `public extension` block), so localSymbols mirrors exports — same heuristic
// choice as the kotlin and dart adapters.

import path from "node:path";

import type { LanguageAdapter, LanguageAnalysis } from "../types";
import { buildLineDepths } from "./source-scan";

const SWIFT_EXTENSIONS = new Set([".swift"]);

// Modifier set shared between leading and trailing modifier groups.
const MOD =
  "public|open|final|static|class|override|mutating|nonmutating|required|convenience|lazy|weak|unowned|dynamic|private\\(set\\)|fileprivate\\(set\\)|internal\\(set\\)|@objc|@objcMembers|@discardableResult|@inlinable";

// PUBLIC_DECL_RE: matches a public/open declaration at the start of a (stripped) line.
//   Group 1 — the declaration keyword
//   Group 2 — the identifier/operator name (may be absent for init/subscript)
//
// Keywords with no following name (init, subscript): name group is optional; callers
// emit a synthetic stable name when group 2 is absent.
//
// Operator functions: after `func` the name may be an operator token instead of an
// identifier. We accept operator-chars sequences like `+`, `==`, `<=`, `??`, etc.
//
// extension: captured but the caller skips the type-name export and instead tracks
// the block to extract its directly-declared public members.
const PUBLIC_DECL_RE = new RegExp(
  // Leading optional modifiers
  `^(?:(?:${MOD})\\s+)*` +
  // Required public|open (the visibility gate)
  `(?:public|open)\\s+` +
  // Optional trailing modifiers (e.g. `public static func`)
  `(?:(?:${MOD})\\s+)*` +
  // Keyword — captured in group 1
  `(class|struct|enum|protocol|func|let|var|extension|actor|typealias|init|subscript)` +
  // Optional `?` for init? or generic param `<...>` for subscript — non-capturing, ignored
  `[?<]?\\s*` +
  // Name — captured in group 2. Either:
  //   - standard identifier: [A-Za-z_][A-Za-z0-9_]*
  //   - operator token: one or more of + - * / % = < > ! & | ^ ~ ? . (Swift operator chars)
  //     (space-separated operator like `func + ` — the \\s* above already consumed leading space)
  `([A-Za-z_][A-Za-z0-9_]*|[+\\-*/%=<>!&|^~?]+|[.](?:[.]{1,2})?)?`
);

// Regex for detecting a public member declaration INSIDE a public extension block (depth 1).
// Matches lines that are either:
//   - explicitly `public …` (inherits public), or
//   - a bare declaration with no explicit access modifier (inherits extension access level).
// Group 1 — keyword, Group 2 — name (optional for init/subscript).
const EXT_MEMBER_RE = new RegExp(
  // Optional leading modifiers (final, static, override, etc.) — but NOT a private/fileprivate/internal access gate.
  // We only match lines that don't start with an explicit restricting access modifier.
  `^(?!(?:private|fileprivate|internal)\\b)` +
  `(?:(?:${MOD})\\s+)*` +
  // Keyword
  `(func|var|let|init|subscript|typealias|class|struct|enum|actor|protocol)` +
  `[?<]?\\s*` +
  // Name
  `([A-Za-z_][A-Za-z0-9_]*|[+\\-*/%=<>!&|^~?]+|[.](?:[.]{1,2})?)?`
);

const TEST_IMPORT_RE = /import\s+(XCTest|Testing)\b/;
const XCTEST_INHERIT_RE = /:\s*XCTestCase\b/;
const TEST_ANNOTATION_RE = /@Test\b/;

const COMMENT_RE = /^\s*(\/\/|\/\*|\*)/;

// Annotation identifier: @Qualified.Name, no args or balanced-paren args follow.
const SWIFT_ANNOTATION_IDENT_RE = /^@[A-Za-z_][A-Za-z0-9_.]*/;

// FIX-B: strip ALL leading Swift annotations (including @available(...)-style with nested parens).
// Mirrors kotlin.ts stripLeadingAnnotations — local copy to avoid cross-adapter coupling.
function stripLeadingAnnotations(line: string): string {
  let pos = 0;
  const len = line.length;

  while (pos < len) {
    // Skip leading whitespace
    while (pos < len && line[pos] === " ") pos++;
    if (pos >= len || line[pos] !== "@") break;

    // Match @Ident
    const identMatch = SWIFT_ANNOTATION_IDENT_RE.exec(line.slice(pos));
    if (!identMatch) break;
    pos += identMatch[0].length;

    // Optionally consume balanced parens (e.g. @available(iOS 14, *))
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
    // Skip trailing whitespace after annotation before looking for another
    while (pos < len && line[pos] === " ") pos++;
  }

  return line.slice(pos);
}

// Synthetic stable names for keywords that carry no identifier name token.
// KNOWN LIMITATION (init/subscript dedup): multiple `init` overloads in one file
// all map to the single synthetic name "init", so they collapse to one entry in
// the exports Set. Similarly for `subscript`. This is intentional — the Set is a
// surface-counting heuristic, not an overload-aware index — and matching by name
// alone is sufficient for MODULE_MAP parity checks.
const SYNTHETIC: Partial<Record<string, string>> = {
  init: "init",
  subscript: "subscript",
};

// Swift declaration keywords that are pure type-only abstractions.
// `protocol` and `typealias` → TYPE. Everything else → VALUE.
const SWIFT_TYPE_KEYWORDS = new Set(["protocol", "typealias"]);

type SwiftExportSets = {
  exports: Set<string>;
  valueExports: Set<string>;
  typeExports: Set<string>;
};

function extractSwiftPublicExports(text: string): SwiftExportSets {
  const exports = new Set<string>();
  const valueExports = new Set<string>();
  const typeExports = new Set<string>();
  const lines = text.split("\n");
  const lineDepths = buildLineDepths(text);

  // Track whether we are currently inside a `public extension` block.
  // When true, members at depth 1 (directly inside the block) are harvested
  // as public exports (they inherit the extension's access level).
  // The block closes when depth returns to 0.
  //
  // KNOWN LIMITATION (single-line extension): a declaration of the form
  //   `public extension Foo { func bar() {} }`
  // on a single line will NOT have its members harvested. The inside-extension
  // tracking relies on `buildLineDepths` returning depth 0 on a *later* line to
  // signal exit; when the entire block sits on one line, the depth never returns
  // to 0 on a subsequent line so `insidePublicExtension` is set but immediately
  // cleared by the next depth-0 line (or end-of-file). This is a known heuristic
  // trade-off — single-line multi-member extensions are rare in production code.
  let insidePublicExtension = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const depthAtLineStart = lineDepths[idx] ?? 0;
    const line = lines[idx]!.trim();

    if (!line || COMMENT_RE.test(line)) {
      continue;
    }

    // When depth drops back to 0 we have left the extension block.
    if (insidePublicExtension && depthAtLineStart === 0) {
      insidePublicExtension = false;
    }

    // FIX-B: strip leading same-line annotations.
    const stripped = stripLeadingAnnotations(line).trim();
    if (!stripped) {
      continue;
    }

    if (insidePublicExtension) {
      // Only harvest direct members (depth 1 = one brace level inside extension).
      if (depthAtLineStart !== 1) {
        continue;
      }
      const memberMatch = EXT_MEMBER_RE.exec(stripped);
      if (memberMatch) {
        const kw = memberMatch[1]!;
        const name = memberMatch[2] ?? SYNTHETIC[kw];
        if (name) {
          exports.add(name);
          // Extension members (func/var/let/init/subscript inside an extension block)
          // are always value-like (methods/properties), not type declarations.
          valueExports.add(name);
        }
      }
      continue;
    }

    // Top-level declarations only (depth 0).
    if (depthAtLineStart !== 0) {
      continue;
    }

    const match = PUBLIC_DECL_RE.exec(stripped);
    if (!match) {
      continue;
    }

    const kw = match[1]!;
    const name = match[2] ?? SYNTHETIC[kw];

    if (kw === "extension") {
      // Do NOT emit the extended type name as an export.
      // Enter extension mode to harvest members at depth 1.
      // exportConfidence stays heuristic — member extraction is heuristic.
      insidePublicExtension = true;
      continue;
    }

    if (name) {
      exports.add(name);
      // Classify: protocol, typealias → TYPE; everything else → VALUE
      if (SWIFT_TYPE_KEYWORDS.has(kw)) {
        typeExports.add(name);
      } else {
        valueExports.add(name);
      }
    }
  }

  return { exports, valueExports, typeExports };
}

// FIX-C: bare `func test*` naming is insufficient for test-framework detection.
// A production file may have methods named testConnection, testReachability, etc.
// Only flag usesTestFramework when there is a real test signal:
//   - XCTest/Testing import, or
//   - class inheriting XCTestCase, or
//   - @Test annotation (Swift Testing framework).
function isTestFile(text: string): boolean {
  return (
    TEST_IMPORT_RE.test(text) ||
    XCTEST_INHERIT_RE.test(text) ||
    TEST_ANNOTATION_RE.test(text)
  );
}

export function createSwiftAdapter(): LanguageAdapter {
  return {
    id: "swift",
    supports(filePath) {
      return SWIFT_EXTENSIONS.has(path.extname(filePath));
    },
    analyze(_filePath, text) {
      const { exports, valueExports, typeExports } = extractSwiftPublicExports(text);
      const usesTestFramework = isTestFile(text);

      const analysis: LanguageAnalysis = {
        adapterId: "swift",
        exports,
        valueExports,
        typeExports,
        localSymbols: new Set(exports),
        exportConfidence: "heuristic",
        hasDefaultExport: false,
        hasWildcardReExport: false,
        hasMainEntrypoint: /@main\b/.test(text) || /\bstatic\s+func\s+main\s*\(/.test(text),
        directReExportCount: 0,
        localExportCount: exports.size,
        localImplementationCount: exports.size,
        usesTestFramework,
      };

      return analysis;
    },
  };
}
