// START_MODULE_CONTRACT
//   PURPOSE: Language adapter for Vue SFC (.vue) files.
//   SCOPE: Extracts exports from <script>/<script setup> block via TS helper; heuristic confidence.
//          For <script setup>: extracts top-level bindings (auto-exposed) + defineExpose() keys.
//   DEPENDS: typescript, types
//   LINKS: M-LINT-ADAPTERS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   createVueAdapter - Factory for the Vue SFC LanguageAdapter.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.4.1 - fix: extractSetupBindings handles object/array destructuring; imports excluded]
// END_CHANGE_SUMMARY

import path from "node:path";
import ts from "typescript";

import type { LanguageAdapter, LanguageAnalysis } from "../types";
import { analyzeTypeScriptSource } from "./typescript";

const VUE_EXTENSIONS = new Set([".vue"]);

// BUG-2 fix: global flag to match ALL script blocks in the SFC.
// Also skip blocks with src= attribute (external, no inline content).
const SCRIPT_BLOCK_RE = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
const SRC_ATTR_RE = /\bsrc\s*=/i;
const SETUP_ATTR_RE = /\bsetup\b/i;

type ScriptBlock = {
  attrs: string;
  content: string;
  isSetup: boolean;
};

function extractScriptBlocks(text: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  let match: RegExpExecArray | null;
  // Reset lastIndex before iterating (safety for reuse).
  SCRIPT_BLOCK_RE.lastIndex = 0;
  while ((match = SCRIPT_BLOCK_RE.exec(text)) !== null) {
    const attrs = match[1];
    const content = match[2];
    if (SRC_ATTR_RE.test(attrs)) {
      continue; // external block — no inline content to analyse
    }
    if (content.trim()) {
      blocks.push({ attrs, content, isSetup: SETUP_ATTR_RE.test(attrs) });
    }
  }
  return blocks;
}

/**
 * Extract names from defineExpose({ a, b, c }) or defineExpose({ a: expr, b: expr }).
 * Returns the key names passed to defineExpose, if present.
 * Only the outermost call is matched (first occurrence).
 */
function extractDefineExposeKeys(content: string): string[] {
  // Match defineExpose({ ... }) — capture the object literal body.
  // Use a simple brace-depth tracker to find the matching close brace.
  const start = content.indexOf("defineExpose(");
  if (start === -1) return [];

  // Find the opening brace of the object argument.
  const braceStart = content.indexOf("{", start + "defineExpose(".length);
  if (braceStart === -1) return [];

  // Walk forward to find matching close brace.
  let depth = 1;
  let i = braceStart + 1;
  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  const objectBody = content.slice(braceStart + 1, i - 1);

  // Extract keys: `key` (shorthand) or `key:` (named).
  // Split by comma, then extract the identifier before an optional colon.
  const keys: string[] = [];
  for (const segment of objectBody.split(",")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    // Key is the identifier before an optional colon (and optional whitespace).
    const keyMatch = /^([a-zA-Z_$][a-zA-Z0-9_$]*)/.exec(trimmed);
    if (keyMatch) {
      keys.push(keyMatch[1]);
    }
  }
  return keys;
}

/**
 * Extract top-level binding names from a <script setup> block using the TS compiler.
 * In <script setup>, VariableStatement / FunctionDeclaration / ClassDeclaration /
 * EnumDeclaration at depth 0 are auto-exposed (no export keyword needed).
 * We also honor explicit `export` declarations via analyzeTypeScriptSource.
 * Private-ish convention (_prefixed) is included — all top-level bindings are considered
 * potentially part of the component surface in setup mode (documented choice).
 */
function extractSetupBindings(virtualPath: string, content: string): Set<string> {
  const names = new Set<string>();

  const sourceFile = ts.createSourceFile(
    virtualPath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  // Recursively collect bound identifier names from a binding pattern.
  // For object patterns: `{ data }` → ["data"]; `{ data: renamed }` → ["renamed"].
  // For array patterns: `[a, b]` → ["a", "b"]; nested patterns recurse.
  // Imports are never reached here because ImportDeclaration is a separate statement kind.
  function collectBindingNames(pattern: ts.BindingName): void {
    if (ts.isIdentifier(pattern)) {
      names.add(pattern.text);
    } else if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element as ts.Node)) continue;
        // element.name is the local binding name (after optional rename)
        collectBindingNames((element as ts.BindingElement).name);
      }
    } else if (ts.isArrayBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) continue;
        collectBindingNames((element as ts.BindingElement).name);
      }
    }
  }

  for (const statement of sourceFile.statements) {
    // Skip import declarations — imported names must never be treated as setup exports.
    if (ts.isImportDeclaration(statement)) {
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        // Handles plain identifier, object destructuring, and array destructuring.
        collectBindingNames(decl.name);
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isEnumDeclaration(statement)) {
      names.add(statement.name.text);
    }
  }

  return names;
}

function mergeAnalyses(
  base: LanguageAnalysis,
  next: LanguageAnalysis,
): LanguageAnalysis {
  return {
    ...base,
    exports: new Set([...base.exports, ...next.exports]),
    valueExports: new Set([...base.valueExports, ...next.valueExports]),
    typeExports: new Set([...base.typeExports, ...next.typeExports]),
    hasDefaultExport: base.hasDefaultExport || next.hasDefaultExport,
    hasWildcardReExport: base.hasWildcardReExport || next.hasWildcardReExport,
    hasMainEntrypoint: base.hasMainEntrypoint || next.hasMainEntrypoint,
    directReExportCount: base.directReExportCount + next.directReExportCount,
    localExportCount: base.localExportCount + next.localExportCount,
    localImplementationCount: base.localImplementationCount + next.localImplementationCount,
    usesTestFramework: base.usesTestFramework || next.usesTestFramework,
  };
}

const EMPTY_ANALYSIS: LanguageAnalysis = {
  adapterId: "vue",
  exports: new Set<string>(),
  valueExports: new Set<string>(),
  typeExports: new Set<string>(),
  exportConfidence: "heuristic",
  exportsComplete: false,
  hasDefaultExport: false,
  hasWildcardReExport: false,
  hasMainEntrypoint: false,
  directReExportCount: 0,
  localExportCount: 0,
  localImplementationCount: 0,
  usesTestFramework: false,
};

export function createVueAdapter(): LanguageAdapter {
  return {
    id: "vue",
    supports(filePath) {
      return VUE_EXTENSIONS.has(path.extname(filePath));
    },
    analyze(filePath, text) {
      const blocks = extractScriptBlocks(text);

      if (blocks.length === 0) {
        return { ...EMPTY_ANALYSIS } satisfies LanguageAnalysis;
      }

      const virtualPath = filePath.replace(/\.vue$/, ".ts");

      // Merge analyses from all script blocks.
      let merged: LanguageAnalysis = { ...EMPTY_ANALYSIS };
      for (const block of blocks) {
        const inner = analyzeTypeScriptSource(virtualPath, block.content);

        if (block.isSetup) {
          // <script setup>: top-level bindings are auto-exposed (no export keyword needed).
          // Union: explicit exports (via TS analyzer) + all top-level bindings + defineExpose keys.
          const setupBindings = extractSetupBindings(virtualPath, block.content);
          const defineExposeKeys = extractDefineExposeKeys(block.content);
          for (const name of setupBindings) {
            inner.exports.add(name);
            inner.valueExports.add(name);
          }
          for (const key of defineExposeKeys) {
            inner.exports.add(key);
            inner.valueExports.add(key);
          }
        }

        merged = mergeAnalyses(merged, inner);
      }

      // SFC <script setup> exposes bindings implicitly — confidence stays heuristic.
      // Regex-based SFC block extraction can miss implicit bindings — extraction is incomplete.
      return {
        ...merged,
        adapterId: "vue",
        exportConfidence: "heuristic",
        exportsComplete: false,
      };
    },
  };
}
