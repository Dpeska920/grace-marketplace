// Stateful source scanner for nesting-depth tracking across lines. Used by the
// Kotlin, Swift, and Vue adapters (and any future line-oriented heuristic adapter)
// to avoid being confused by braces, parens, or brackets that appear inside
// string/char/comment content.
//
// Tracks {}, (), and [] as a single combined nesting depth; <> are intentionally NOT
// tracked (unreliable — also used as comparison/generic operators).

// Scan `text` character-by-character, tracking:
//   - triple-quoted strings: triple-double and triple-single (Kotlin / Dart)
//   - regular double/single-quoted strings with escape handling
//   - Dart raw strings (r'...' / R"..."): backslash is literal, no escape handling
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
    | "triple-single"
    | "raw-double"
    | "raw-single";

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
        // Dart raw-string prefix: `r`/`R` immediately followed by a quote,
        // with the prefix itself not part of an identifier (`var r = 'x'`
        // must not be misread as a raw string). In a raw string a backslash
        // is LITERAL, never an escape, so `r'\'` must not consume its own
        // closing quote via escape handling. `r'''` / `r"""` (raw triple
        // strings) fall through to the triple-quote handling below, which
        // already ignores escapes.
        if (
          (ch === "r" || ch === "R") &&
          (text[i + 1] === "'" || text[i + 1] === '"') &&
          text[i + 1] !== text[i + 2] &&
          !(i > 0 && /[A-Za-z0-9_$]/.test(text[i - 1] ?? ""))
        ) {
          state = text[i + 1] === "'" ? "raw-single" : "raw-double";
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

      case "raw-double":
        // Dart raw string r"..." / R"...": backslash is literal, NOT an
        // escape — skip straight to the matching double quote.
        if (ch === '"') {
          state = "normal";
          i++;
        } else {
          i++;
        }
        break;

      case "raw-single":
        // Dart raw string r'...' / R'...': backslash is literal, NOT an
        // escape — skip straight to the matching single quote.
        if (ch === "'") {
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
