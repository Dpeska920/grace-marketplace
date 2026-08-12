// Language adapter for Swift source files.
// Heuristic export analysis for public/open declarations; test-role detection.
//
// Ported from the fork/v3 adapter. localSymbols captures every top-level
// declaration the regex extraction finds regardless of access level
// (default `internal`, explicit `private`/`fileprivate`/`internal`, or
// `public`/`open`); exports keeps only the declarations gated behind an
// explicit `public`/`open` modifier (or inherited from a `public`/`open`
// extension block). localSymbols is always a superset of exports.

import path from "node:path";

import type { LanguageAdapter, LanguageAnalysis } from "../types";
import { buildLineDepths } from "./source-scan";

const SWIFT_EXTENSIONS = new Set([".swift"]);

// Modifier set shared between leading and trailing modifier groups.
// Includes the bare `private`/`fileprivate`/`internal` access keywords too, so
// the declaration regexes below match a declaration regardless of its access
// level — visibility is decided afterwards by inspecting the captured
// modifiers text, not by gating the regex match itself.
const MOD =
  "public|open|private|fileprivate|internal|final|static|class|override|mutating|nonmutating|required|convenience|lazy|weak|unowned|dynamic|private\\(set\\)|fileprivate\\(set\\)|internal\\(set\\)|@objc|@objcMembers|@discardableResult|@inlinable";

// ALL_DECL_RE: matches a top-level declaration at the start of a (stripped) line,
// regardless of access level.
//   Group 1 — the full leading modifiers text (used to test for public/open)
//   Group 2 — the declaration keyword
//   Group 3 — the identifier/operator name (may be absent for init/subscript)
//
// Keywords with no following name (init, subscript): name group is optional; callers
// emit a synthetic stable name when group 3 is absent.
//
// Operator functions: after `func` the name may be an operator token instead of an
// identifier. We accept operator-chars sequences like `+`, `==`, `<=`, `??`, etc.
//
// extension: captured but the caller skips the type-name export and instead tracks
// the block to extract its directly-declared members.
const ALL_DECL_RE = new RegExp(
  // Leading modifiers, captured so callers can test for public/open.
  `^((?:(?:${MOD})\\s+)*)` +
  // Keyword — captured in group 2
  `(class|struct|enum|protocol|func|let|var|extension|actor|typealias|init|subscript)` +
  // Optional `?` for init? or generic param `<...>` for subscript — non-capturing, ignored
  `[?<]?\\s*` +
  // Name — captured in group 3. Either:
  //   - standard identifier: [A-Za-z_][A-Za-z0-9_]*
  //   - operator token: one or more of + - * / % = < > ! & | ^ ~ ? . (Swift operator chars)
  //     (space-separated operator like `func + ` — the \\s* above already consumed leading space)
  `([A-Za-z_][A-Za-z0-9_]*|[+\\-*/%=<>!&|^~?]+|[.](?:[.]{1,2})?)?`
);

// Regex for detecting a member declaration INSIDE an extension block (depth 1),
// regardless of access level. Group 1 — modifiers, Group 2 — keyword, Group 3 — name.
const ALL_EXT_MEMBER_RE = new RegExp(
  `^((?:(?:${MOD})\\s+)*)` +
  // Keyword
  `(func|var|let|init|subscript|typealias|class|struct|enum|actor|protocol)` +
  `[?<]?\\s*` +
  // Name
  `([A-Za-z_][A-Za-z0-9_]*|[+\\-*/%=<>!&|^~?]+|[.](?:[.]{1,2})?)?`
);

const PUBLIC_MODIFIER_RE = /\b(?:public|open)\b/;
// Negative lookahead excludes the accessor-level `private(set)` / `fileprivate(set)` /
// `internal(set)` modifiers, which restrict only the setter, not the declaration itself.
const RESTRICTED_MODIFIER_RE = /\b(?:private|fileprivate|internal)\b(?!\()/;

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
  localSymbols: Set<string>;
};

function extractSwiftPublicExports(text: string): SwiftExportSets {
  const exports = new Set<string>();
  const valueExports = new Set<string>();
  const typeExports = new Set<string>();
  const localSymbols = new Set<string>();
  const lines = text.split("\n");
  const lineDepths = buildLineDepths(text);

  // Track whether we are currently inside an extension block (any access level).
  // Members at depth 1 (directly inside the block) are always harvested into
  // localSymbols; they are also harvested into exports when the extension
  // itself is public/open (they inherit the extension's access level) and the
  // member has no explicit restricting access modifier of its own.
  // The block closes when depth returns to 0.
  //
  // KNOWN LIMITATION (single-line extension): a declaration of the form
  //   `public extension Foo { func bar() {} }`
  // on a single line will NOT have its members harvested. The inside-extension
  // tracking relies on `buildLineDepths` returning depth 0 on a *later* line to
  // signal exit; when the entire block sits on one line, the depth never returns
  // to 0 on a subsequent line so `insideExtension` is set but immediately
  // cleared by the next depth-0 line (or end-of-file). This is a known heuristic
  // trade-off — single-line multi-member extensions are rare in production code.
  let insideExtension = false;
  let extensionIsPublic = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const depthAtLineStart = lineDepths[idx] ?? 0;
    const line = lines[idx]!.trim();

    if (!line || COMMENT_RE.test(line)) {
      continue;
    }

    // When depth drops back to 0 we have left the extension block.
    if (insideExtension && depthAtLineStart === 0) {
      insideExtension = false;
    }

    // FIX-B: strip leading same-line annotations.
    const stripped = stripLeadingAnnotations(line).trim();
    if (!stripped) {
      continue;
    }

    if (insideExtension) {
      // Only harvest direct members (depth 1 = one brace level inside extension).
      if (depthAtLineStart !== 1) {
        continue;
      }
      const memberMatch = ALL_EXT_MEMBER_RE.exec(stripped);
      if (memberMatch) {
        const modifiers = memberMatch[1] ?? "";
        const kw = memberMatch[2]!;
        const name = memberMatch[3] ?? SYNTHETIC[kw];
        if (name) {
          localSymbols.add(name);
          const isRestricted = RESTRICTED_MODIFIER_RE.test(modifiers);
          if (extensionIsPublic && !isRestricted) {
            exports.add(name);
            // Extension members (func/var/let/init/subscript inside an extension block)
            // are always value-like (methods/properties), not type declarations.
            valueExports.add(name);
          }
        }
      }
      continue;
    }

    // Top-level declarations only (depth 0).
    if (depthAtLineStart !== 0) {
      continue;
    }

    const match = ALL_DECL_RE.exec(stripped);
    if (!match) {
      continue;
    }

    const modifiers = match[1] ?? "";
    const kw = match[2]!;
    const name = match[3] ?? SYNTHETIC[kw];
    const isPublic = PUBLIC_MODIFIER_RE.test(modifiers);

    if (kw === "extension") {
      // Do NOT emit the extended type name as an export or local symbol.
      // Enter extension mode to harvest members at depth 1.
      // exportConfidence stays heuristic — member extraction is heuristic.
      insideExtension = true;
      extensionIsPublic = isPublic;
      continue;
    }

    if (name) {
      localSymbols.add(name);
      if (!isPublic) {
        continue;
      }
      exports.add(name);
      // Classify: protocol, typealias → TYPE; everything else → VALUE
      if (SWIFT_TYPE_KEYWORDS.has(kw)) {
        typeExports.add(name);
      } else {
        valueExports.add(name);
      }
    }
  }

  return { exports, valueExports, typeExports, localSymbols };
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
      const { exports, valueExports, typeExports, localSymbols } = extractSwiftPublicExports(text);
      const usesTestFramework = isTestFile(text);

      const analysis: LanguageAnalysis = {
        adapterId: "swift",
        exports,
        valueExports,
        typeExports,
        localSymbols,
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
