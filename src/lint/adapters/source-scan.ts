// START_MODULE_CONTRACT
//   PURPOSE: Stateful source scanner for nesting-depth tracking across lines and
//            string-content masking for false-positive suppression.
//   SCOPE: Handles triple-quoted strings (Kotlin/Dart), regular strings, backtick
//          template literals, line comments, and block comments so that brackets
//          inside literals/comments do not affect the computed depth. Tracks {},
//          (), and [] as a single combined nesting depth; <> are intentionally NOT
//          tracked (unreliable).
//   DEPENDS: none
//   LINKS: M-LINT-ADAPTERS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   buildLineDepths - Scan source text and return depth-at-line-start array.
//   maskStringContents - Return text with interior chars of string/char/template literals replaced by spaces.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.3.1 - FIX: preserve newlines through backslash-newline line-continuation in string states; guard EOF trailing backslash in both buildLineDepths and maskStringContents]
// END_CHANGE_SUMMARY

// Scan `text` character-by-character, tracking:
//   - triple-quoted strings: triple-double and triple-single (Kotlin / Dart)
//   - regular double/single-quoted strings with escape handling
//   - line comments (//) and block comments (/* */)
//
// Returns an array where result[i] is the combined nesting depth ({} + () + [])
// at the START of line i (0-indexed). Use result[lineIndex] === 0 to test
// top-level position (not inside any block, parameter list, or array literal).
export function buildLineDepths(text: string): number[] {
  const depths: number[] = [];
  let depth = 0;

  type State =
    | "normal"
    | "line-comment"
    | "block-comment"
    | "string-double"
    | "string-single"
    | "triple-double"
    | "triple-single";

  let state: State = "normal";
  let i = 0;
  let lineStart = true;

  while (i < text.length) {
    if (lineStart) {
      depths.push(depth);
      lineStart = false;
    }

    const ch = text[i];
    const peek2 = text.slice(i, i + 2);
    const peek3 = text.slice(i, i + 3);

    if (ch === "\n") {
      // End of line — reset line-comment state
      if (state === "line-comment") {
        state = "normal";
      }
      lineStart = true;
      i++;
      continue;
    }

    switch (state) {
      case "normal": {
        if (peek3 === '"""') {
          state = "triple-double";
          i += 3;
          continue;
        }
        if (peek3 === "'''") {
          state = "triple-single";
          i += 3;
          continue;
        }
        if (peek2 === "//") {
          state = "line-comment";
          i += 2;
          continue;
        }
        if (peek2 === "/*") {
          state = "block-comment";
          i += 2;
          continue;
        }
        if (ch === '"') {
          state = "string-double";
          i++;
          continue;
        }
        if (ch === "'") {
          state = "string-single";
          i++;
          continue;
        }
        if (ch === "{" || ch === "(" || ch === "[") {
          depth++;
        } else if ((ch === "}" || ch === ")" || ch === "]") && depth > 0) {
          depth--;
        }
        i++;
        break;
      }

      case "line-comment":
        // Skip until newline (handled above)
        i++;
        break;

      case "block-comment":
        if (peek2 === "*/") {
          state = "normal";
          i += 2;
        } else {
          i++;
        }
        break;

      case "triple-double":
        if (peek3 === '"""') {
          state = "normal";
          i += 3;
        } else {
          i++;
        }
        break;

      case "triple-single":
        if (peek3 === "'''") {
          state = "normal";
          i += 3;
        } else {
          i++;
        }
        break;

      case "string-double":
        if (ch === "\\") {
          // Guard EOF: trailing backslash — advance 1 only.
          if (i + 1 >= text.length) {
            i++;
          } else if (text[i + 1] === "\n") {
            // Line-continuation: skip the backslash only; let the \n handler
            // above register the line boundary normally.
            i++;
          } else if (text[i + 1] === "\r" && text[i + 2] === "\n") {
            // CRLF line-continuation: skip backslash + CR; \n handled above.
            i += 2;
          } else {
            i += 2; // skip escaped char (normal case)
          }
        } else if (ch === '"') {
          state = "normal";
          i++;
        } else {
          i++;
        }
        break;

      case "string-single":
        if (ch === "\\") {
          if (i + 1 >= text.length) {
            i++;
          } else if (text[i + 1] === "\n") {
            i++;
          } else if (text[i + 1] === "\r" && text[i + 2] === "\n") {
            i += 2;
          } else {
            i += 2;
          }
        } else if (ch === "'") {
          state = "normal";
          i++;
        } else {
          i++;
        }
        break;
    }
  }

  return depths;
}

// Scan `text` and return a copy where the INTERIOR characters of string/char/
// template literals are replaced with spaces (one space per masked character).
// Preserved as-is: quote/backtick delimiters themselves, all newlines (so line
// numbers and offsets are unchanged), comment text (both // and /* */ forms),
// and all ordinary code outside of literals.
//
// This lets callers scan for markup tokens without being confused by the same
// token appearing inside a string literal (e.g. a log-label constant).
//
// Known heuristic limit (inherited from buildLineDepths): ${ } interpolation
// inside backtick template literals is NOT tracked — a nested quote inside ${}
// may prematurely close the outer template. This is acceptable per design.
export function maskStringContents(text: string): string {
  type State =
    | "normal"
    | "line-comment"
    | "block-comment"
    | "string-double"
    | "string-single"
    | "string-backtick"
    | "triple-double"
    | "triple-single";

  let state: State = "normal";
  let i = 0;
  const out: string[] = [];

  while (i < text.length) {
    const ch = text[i];
    const peek2 = text.slice(i, i + 2);
    const peek3 = text.slice(i, i + 3);

    switch (state) {
      case "normal": {
        if (peek3 === '"""') {
          out.push('"""');
          state = "triple-double";
          i += 3;
          continue;
        }
        if (peek3 === "'''") {
          out.push("'''");
          state = "triple-single";
          i += 3;
          continue;
        }
        if (peek2 === "//") {
          state = "line-comment";
          out.push("//");
          i += 2;
          continue;
        }
        if (peek2 === "/*") {
          state = "block-comment";
          out.push("/*");
          i += 2;
          continue;
        }
        if (ch === "`") {
          out.push("`");
          state = "string-backtick";
          i++;
          continue;
        }
        if (ch === '"') {
          out.push('"');
          state = "string-double";
          i++;
          continue;
        }
        if (ch === "'") {
          out.push("'");
          state = "string-single";
          i++;
          continue;
        }
        // Ordinary code — pass through verbatim.
        out.push(ch);
        i++;
        break;
      }

      case "line-comment":
        // Comment content is preserved as-is.
        if (ch === "\n") {
          state = "normal";
        }
        out.push(ch);
        i++;
        break;

      case "block-comment":
        // Block comment content is preserved as-is.
        if (peek2 === "*/") {
          out.push("*/");
          state = "normal";
          i += 2;
        } else {
          out.push(ch);
          i++;
        }
        break;

      case "triple-double":
        if (ch === "\n") {
          // Preserve newlines to keep line numbers intact.
          out.push("\n");
          i++;
        } else if (peek3 === '"""') {
          out.push('"""');
          state = "normal";
          i += 3;
        } else {
          // Mask interior character.
          out.push(" ");
          i++;
        }
        break;

      case "triple-single":
        if (ch === "\n") {
          out.push("\n");
          i++;
        } else if (peek3 === "'''") {
          out.push("'''");
          state = "normal";
          i += 3;
        } else {
          out.push(" ");
          i++;
        }
        break;

      case "string-double":
        if (ch === "\n") {
          // Unterminated single-line string — treat newline as string end.
          state = "normal";
          out.push("\n");
          i++;
        } else if (ch === "\\") {
          if (i + 1 >= text.length) {
            // Trailing backslash at EOF — mask one char, advance 1.
            out.push(" ");
            i++;
          } else if (text[i + 1] === "\n") {
            // Line-continuation: mask backslash, preserve newline.
            out.push(" \n");
            i += 2;
          } else if (text[i + 1] === "\r" && i + 2 < text.length && text[i + 2] === "\n") {
            // CRLF line-continuation: mask backslash + CR, preserve newline.
            out.push(" \n");
            i += 3;
          } else {
            // Normal escape — mask both chars.
            out.push("  ");
            i += 2;
          }
        } else if (ch === '"') {
          out.push('"');
          state = "normal";
          i++;
        } else {
          out.push(" ");
          i++;
        }
        break;

      case "string-single":
        if (ch === "\n") {
          state = "normal";
          out.push("\n");
          i++;
        } else if (ch === "\\") {
          if (i + 1 >= text.length) {
            out.push(" ");
            i++;
          } else if (text[i + 1] === "\n") {
            out.push(" \n");
            i += 2;
          } else if (text[i + 1] === "\r" && i + 2 < text.length && text[i + 2] === "\n") {
            out.push(" \n");
            i += 3;
          } else {
            out.push("  ");
            i += 2;
          }
        } else if (ch === "'") {
          out.push("'");
          state = "normal";
          i++;
        } else {
          out.push(" ");
          i++;
        }
        break;

      case "string-backtick":
        if (ch === "\n") {
          // Backtick strings CAN span lines; preserve the newline.
          out.push("\n");
          i++;
        } else if (ch === "\\") {
          if (i + 1 >= text.length) {
            out.push(" ");
            i++;
          } else if (text[i + 1] === "\n") {
            out.push(" \n");
            i += 2;
          } else if (text[i + 1] === "\r" && i + 2 < text.length && text[i + 2] === "\n") {
            out.push(" \n");
            i += 3;
          } else {
            out.push("  ");
            i += 2;
          }
        } else if (ch === "`") {
          out.push("`");
          state = "normal";
          i++;
        } else {
          out.push(" ");
          i++;
        }
        break;
    }
  }

  return out.join("");
}
