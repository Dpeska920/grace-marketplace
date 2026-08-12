import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export type TextSection = {
  content: string;
  startLine: number;
  endLine: number;
};

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".py",
  ".pyi",
  ".go",
  ".java",
  ".kt",
  ".kts",
  ".rs",
  ".rb",
  ".php",
  ".swift",
  ".dart",
  ".vue",
  ".scala",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".clj",
  ".cljs",
  ".cljc",
]);

export function normalizeRelative(root: string, filePath: string) {
  return path.relative(root, filePath) || ".";
}

export function lineNumberAt(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

export function readTextIfExists(filePath: string) {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

export function stripQuotedStrings(text: string) {
  let result = "";
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (const char of text) {
    if (!quote) {
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        result += " ";
        continue;
      }

      result += char;
      continue;
    }

    if (escaped) {
      escaped = false;
      result += char === "\n" ? "\n" : " ";
      continue;
    }

    if (char === "\\") {
      escaped = true;
      result += " ";
      continue;
    }

    if (char === quote) {
      quote = null;
      result += " ";
      continue;
    }

    result += char === "\n" ? "\n" : " ";
  }

  return result;
}

export function hasGraceMarkers(text: string) {
  const searchable = stripQuotedStrings(text);
  return searchable
    .split("\n")
    .some((line) => /^(\s*)(\/\/|#|--|;+|\*|<!--)\s*(START_MODULE_CONTRACT|START_MODULE_MAP|START_CONTRACT:|START_BLOCK_|START_CHANGE_SUMMARY)/.test(line));
}

export function collectCodeFiles(root: string, ignoredDirs: string[], currentDir = root): string[] {
  const files: string[] = [];
  const ignoredDirSet = new Set([...DEFAULT_IGNORED_DIRS, ...ignoredDirs]);
  const entries = readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirSet.has(entry.name)) {
        continue;
      }

      files.push(...collectCodeFiles(root, ignoredDirs, path.join(currentDir, entry.name)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const filePath = path.join(currentDir, entry.name);
    if (CODE_EXTENSIONS.has(path.extname(filePath))) {
      files.push(filePath);
    }
  }

  return files;
}

// Shared test-path classifier. Canonical home — all callers import from here.
// test_ bare prefix is NOT a global signal (e.g. lib/core/test_keys.dart is runtime code).
// Suffix signals are language-scoped: _test.dart|py (suffix) and test_*.py (prefix).
export function isLikelyTestPath(relativePath: string): boolean {
  return /(^|\/)(__tests__|tests?)(\/|$)|(^|\/)[^/]+\.(test|spec)\.[^.]+$|(^|\/)[^/]+_test\.(dart|py)$|(^|\/)test_[^/]+\.py$/.test(relativePath);
}

export function stripCommentPrefix(line: string) {
  return line.replace(/^\s*(<!--|\/\/|#|--|;+|\*)?\s*/, "");
}

export function findSection(text: string, startMarker: string, endMarker: string) {
  const startIndex = text.indexOf(startMarker);
  const endIndex = text.indexOf(endMarker);
  if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
    return null;
  }

  return {
    content: text.slice(startIndex + startMarker.length, endIndex),
    startLine: lineNumberAt(text, startIndex),
    endLine: lineNumberAt(text, endIndex),
  } satisfies TextSection;
}
