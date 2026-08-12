// START_MODULE_CONTRACT
//   ROLE: TEST
//   PURPOSE: Unit tests for buildLineDepths and maskStringContents state-machines in source-scan.ts.
//   SCOPE: Edge cases: triple-quoted strings, escape sequences, comment disambiguation,
//          block comments, unclosed states, mixed quotes, string masking.
//   DEPENDS: source-scan
//   LINKS: M-LINT-ADAPTERS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MAP_MODE: NONE
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.3.1 - FIX: add backslash-newline line-continuation and EOF-backslash tests for both functions]
// END_CHANGE_SUMMARY

import { describe, expect, it } from "bun:test";

import { buildLineDepths, maskStringContents } from "./source-scan";

// Helper: split text into lines and return depths as labelled object for readability
function depths(text: string): number[] {
  return buildLineDepths(text);
}

describe("buildLineDepths", () => {
  // --- triple-quoted strings ---

  it('triple-double: unbalanced { } inside """ do not change depth', () => {
    const text = `class Before\nval t = """\n  { unbalanced {\n  spans\n"""\nclass After`;
    //            line0           line1          line2              line3    line4    line5
    const d = depths(text);
    expect(d[0]).toBe(0); // Before
    expect(d[5]).toBe(0); // After — still top-level
  });

  it("triple-single: unbalanced { } inside ''' do not change depth", () => {
    const text = `class Before\nval t = '''\n  { inside\n'''\nclass After`;
    const d = depths(text);
    expect(d[0]).toBe(0);
    expect(d[4]).toBe(0);
  });

  it("triple-quote: depth properly tracks braces outside the string", () => {
    const text = `class Outer {\nval t = """\n  ignored { brace\n"""\nfun method()`;
    // line0: depth 0, line1: depth 1 (after '{'), line4: depth 1 (still inside Outer)
    const d = depths(text);
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(1);
    expect(d[4]).toBe(1);
  });

  // --- regular string with escape ---

  it('regular double-quoted: escaped quote "a\\"b" does not close string early', () => {
    // "a\"b" — the \" should not end the string; { after it must NOT increment depth
    const text = `val x = "a\\"b"\nclass After`;
    const d = depths(text);
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(0); // no brace was counted
  });

  it("regular double-quoted: { after closing quote DOES increment depth", () => {
    const text = `val x = "hello" {\nfun inner()`;
    const d = depths(text);
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(1); // { at end of line 0 incremented depth
  });

  // --- // and /* inside string literals ---

  it("// inside a string literal does not start a line-comment", () => {
    const text = `val url = "http://example.com"\nclass After`;
    const d = depths(text);
    expect(d[1]).toBe(0); // After — not swallowed by fake comment
  });

  it("/* inside a string literal does not start a block-comment", () => {
    const text = `val s = "/* not a comment */"\nclass After`;
    const d = depths(text);
    expect(d[1]).toBe(0);
  });

  // --- multi-line block comment ---

  it("block-comment /* { */ does not affect depth", () => {
    const text = `class First\n/* block { with\n  unmatched braces */\nclass Second`;
    const d = depths(text);
    expect(d[0]).toBe(0);
    expect(d[3]).toBe(0);
  });

  it("line-comment // { does not affect depth", () => {
    const text = `class First\n// { fake depth\nclass Second`;
    const d = depths(text);
    expect(d[0]).toBe(0);
    expect(d[2]).toBe(0);
  });

  // --- unclosed states to EOF ---

  it("unclosed block-comment to EOF returns depths without crash", () => {
    const text = `class Before\n/* unclosed block comment with { brace`;
    const d = depths(text);
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(0); // brace inside unclosed comment is ignored
    expect(d.length).toBe(2);
  });

  it("unclosed triple-quote to EOF returns depths without crash", () => {
    const text = `class Before\nval t = """\n  { unclosed triple quote`;
    const d = depths(text);
    expect(d[0]).toBe(0);
    expect(d.length).toBe(3);
    // braces inside unclosed triple-string are ignored
    expect(d[2]).toBe(0);
  });

  // --- mixed / edge cases ---

  it("single-quoted string with escaped quote does not close early", () => {
    const text = `val c = 'it\\'s'\nclass After`;
    const d = depths(text);
    expect(d[1]).toBe(0);
  });

  it("mixed quotes on one line: double-quoted string followed by single-quoted", () => {
    // Both strings close properly; no stray depth change
    const text = `val a = "hello" + 'world'\nclass After`;
    const d = depths(text);
    expect(d[1]).toBe(0);
  });

  it("empty text returns empty array", () => {
    expect(depths("")).toHaveLength(0);
  });

  it("single line with no newline returns one depth entry", () => {
    const d = depths("class Foo");
    expect(d).toHaveLength(1);
    expect(d[0]).toBe(0);
  });

  // --- documented heuristic limit ---
  // String interpolation ${ ... } with nested quotes is a KNOWN heuristic limit.
  // The state-machine does not track interpolation contexts: a nested quote inside
  // ${ } may prematurely close the outer string. This is acceptable per design
  // (heuristic, no external deps). Do NOT add a passing test for this case.

  // --- FIX-2: () and [] tracked as nesting depth ---

  it("FIX-2: multi-line parenthesized construct — inner lines are depth > 0", () => {
    // class Foo(        <- line 0, depth 0 at start; '(' opens at depth 1 after this char
    //     val a: Int,   <- line 1, depth 1 at start (inside paren)
    //     val b: Int    <- line 2, depth 1 at start
    // )                 <- line 3, depth 1 at start; ')' closes back to 0
    // class Bar         <- line 4, depth 0 at start (back to top-level)
    const text = "class Foo(\n    val a: Int,\n    val b: Int\n)\nclass Bar";
    const d = depths(text);
    expect(d[0]).toBe(0); // class Foo — top-level
    expect(d[1]).toBe(1); // val a — inside parens
    expect(d[2]).toBe(1); // val b — inside parens
    expect(d[3]).toBe(1); // ) — still at depth 1 at line start, closes during this line
    expect(d[4]).toBe(0); // class Bar — back to top-level
  });

  it("FIX-2: multi-line array/collection literal — inner lines are depth > 0", () => {
    // val items = [     <- line 0, depth 0 at start; '[' opens
    //   "a",            <- line 1, depth 1
    //   "b"             <- line 2, depth 1
    // ]                 <- line 3, depth 1 at start; ']' closes
    // class After       <- line 4, depth 0
    const text = "val items = [\n  \"a\",\n  \"b\"\n]\nclass After";
    const d = depths(text);
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(1);
    expect(d[2]).toBe(1);
    expect(d[3]).toBe(1);
    expect(d[4]).toBe(0);
  });

  it("FIX-2: paren inside a string literal does NOT change depth", () => {
    // val s = "func(x)"  <- parens inside string, must not alter depth
    // class After         <- must still be depth 0
    const text = `val s = "func(x)"\nclass After`;
    const d = depths(text);
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(0);
  });

  it("FIX-2: bracket inside a string literal does NOT change depth", () => {
    const text = `val s = "[0]"\nclass After`;
    const d = depths(text);
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(0);
  });

  it("FIX-2: paren inside a line comment does NOT change depth", () => {
    const text = `// (comment\nclass After`;
    const d = depths(text);
    expect(d[1]).toBe(0);
  });

  it("FIX-2: bracket inside a block comment does NOT change depth", () => {
    const text = `class First\n/* [unclosed\n  bracket */\nclass Second`;
    const d = depths(text);
    expect(d[0]).toBe(0);
    expect(d[3]).toBe(0);
  });

  it("FIX-2: existing brace-only depth still works after change", () => {
    // Regression: braces must still increment/decrement correctly
    const text = "class Outer {\nfun method() {}\n}";
    const d = depths(text);
    expect(d[0]).toBe(0); // class Outer {
    expect(d[1]).toBe(1); // inside Outer
    expect(d[2]).toBe(1); // } closing Outer — depth 1 at LINE START
  });

  // --- backslash-newline line-continuation (FIX: newline preservation) ---

  it("backslash-newline inside double-quoted string: depths array length equals line count", () => {
    // "ab\<NL>cd" is a 2-line string literal (line-continuation).
    // The depths array must have one entry per line.
    const text = "const s = \"ab\\\ncd\";\n// START_BLOCK_REAL\nmore";
    const d = depths(text);
    expect(d.length).toBe(text.split("\n").length);
  });

  it("backslash-newline inside double-quoted string: marker on next line is at correct depth", () => {
    // After a backslash-newline in a string the depth must still be 0 on the following line.
    const text = "const s = \"ab\\\ncd\";\nclass After";
    const d = depths(text);
    // line 0: "const s = ..." depth 0
    // line 1: "cd";           depth 0 (still inside string, then string closes)
    // line 2: "class After"   depth 0
    expect(d[0]).toBe(0);
    expect(d[2]).toBe(0);
    expect(d.length).toBe(3);
  });

  it("backslash-newline inside single-quoted string: depths array length equals line count", () => {
    const text = "val s = 'ab\\\ncd';\nclass After";
    const d = depths(text);
    expect(d.length).toBe(text.split("\n").length);
  });

  it("trailing backslash at EOF inside open string: no crash and length is 1", () => {
    // A string that ends with a lone backslash (EOF) — must not go out of bounds.
    const text = "val s = \"abc\\";
    expect(() => depths(text)).not.toThrow();
    const d = depths(text);
    expect(d.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// maskStringContents
// ---------------------------------------------------------------------------

describe("maskStringContents", () => {
  it("masks interior of a double-quoted string containing a marker-like token", () => {
    // A block-anchor token inside the string must be blanked by the masker.
    const input = `const s = "// ${"START"}_${"BLOCK"}_X is inside";`;
    const masked = maskStringContents(input);
    // Delimiters are preserved; interior is spaces.
    expect(masked).toContain('"');
    expect(masked).not.toContain("START_BLOCK");
    // Length is unchanged (spaces replace each char 1-for-1), modulo escape expansion.
    // Character count of masked equals input because no escapes here.
    expect(masked.length).toBe(input.length);
  });

  it("masks interior of a single-quoted string containing parens", () => {
    const input = `val s = 'hello (world)';`;
    const masked = maskStringContents(input);
    // Parens inside the string are masked → no '(' or ')' in the masked interior.
    expect(masked).toContain("'");
    // The outer code (val s = ...) is untouched; the string interior is blanked.
    // After masking, '(' and ')' from inside the string are gone.
    const interiorStart = masked.indexOf("'") + 1;
    const interiorEnd = masked.lastIndexOf("'");
    const interior = masked.slice(interiorStart, interiorEnd);
    expect(interior).not.toContain("(");
    expect(interior).not.toContain(")");
  });

  it("preserves a real // comment (not inside a string)", () => {
    const input = `// START_BLOCK_REAL comment here`;
    const masked = maskStringContents(input);
    // Line comments are preserved verbatim.
    expect(masked).toBe(input);
  });

  it("preserves newlines so line numbers and offsets are unchanged", () => {
    const input = `line one\nconst s = "hello";\nline three`;
    const masked = maskStringContents(input);
    expect(masked.split("\n")).toHaveLength(3);
    // Line 0 and line 2 are outside strings — unchanged.
    const lines = masked.split("\n");
    expect(lines[0]).toBe("line one");
    expect(lines[2]).toBe("line three");
  });

  it("preserves newlines inside a multi-line triple-quoted string", () => {
    const input = `before\n"""\nline A\nline B\n"""\nafter`;
    const masked = maskStringContents(input);
    const lines = masked.split("\n");
    // Same number of lines.
    expect(lines).toHaveLength(6);
    // 'before' and 'after' untouched.
    expect(lines[0]).toBe("before");
    expect(lines[5]).toBe("after");
  });

  it("masks interior of a backtick template literal", () => {
    const marker = `${"START"}_${"BLOCK"}_TMPL`;
    const input = `const s = \`${marker} inside\`;`;
    const masked = maskStringContents(input);
    expect(masked).not.toContain(marker);
    // Backtick delimiters preserved.
    expect(masked).toContain("`");
  });

  it("does NOT mask block comment interior", () => {
    const input = `/* START_BLOCK_FOO */`;
    const masked = maskStringContents(input);
    // Block comment content is preserved.
    expect(masked).toContain("START_BLOCK_FOO");
  });

  it("ordinary code outside strings is unchanged", () => {
    const input = `function foo() { return bar; }`;
    const masked = maskStringContents(input);
    expect(masked).toBe(input);
  });

  it("documented heuristic limit: ${ } interpolation is not tracked (no assertion, guard only)", () => {
    // This test documents that nested quotes inside ${ } may prematurely close
    // the outer template literal — consistent with buildLineDepths limit.
    // We do NOT assert correct behaviour here; we only confirm no crash.
    const input = "const s = `prefix ${ 'nested' } suffix`;";
    expect(() => maskStringContents(input)).not.toThrow();
  });

  // --- backslash-newline line-continuation (FIX: newline preservation) ---

  it("backslash-newline in double-quoted string: output has same line count as input", () => {
    const input = "const s = \"ab\\\ncd\";\n// START_BLOCK_REAL\nmore";
    const out = maskStringContents(input);
    expect(out.split("\n").length).toBe(input.split("\n").length);
  });

  it("backslash-newline in double-quoted string: real marker after the string is preserved at correct line", () => {
    // Line 0: const s = "ab\<NL>
    // Line 1: cd";
    // Line 2: comment containing a block marker token
    const marker = "// " + "START_BLOCK_REAL";
    const input = "const s = \"ab\\\ncd\";\n" + marker + "\nmore";
    const lines = maskStringContents(input).split("\n");
    expect(lines[2]).toBe(marker);
  });

  it("backslash-newline in single-quoted string: output has same line count as input", () => {
    const input = "val s = 'ab\\\ncd';\n// MARKER\nmore";
    const out = maskStringContents(input);
    expect(out.split("\n").length).toBe(input.split("\n").length);
  });

  it("backslash-newline in backtick template: output has same line count as input", () => {
    const input = "const s = `ab\\\ncd`;\n// MARKER\nmore";
    const out = maskStringContents(input);
    expect(out.split("\n").length).toBe(input.split("\n").length);
  });

  it("CRLF backslash-newline in double-quoted string: output has same line count as input", () => {
    // Windows-style CRLF line-continuation inside a string.
    const input = "const s = \"ab\\\r\ncd\";\nmore";
    const out = maskStringContents(input);
    expect(out.split("\n").length).toBe(input.split("\n").length);
  });

  it("trailing backslash at EOF inside open string: no crash and output length is sane", () => {
    const input = "val s = \"abc\\";
    expect(() => maskStringContents(input)).not.toThrow();
    const out = maskStringContents(input);
    // Must not be longer than the input (no extra chars emitted).
    expect(out.length).toBeLessThanOrEqual(input.length);
    // Must not be shorter than the opening quote position (content exists).
    expect(out.length).toBeGreaterThan(0);
  });

  it("integration: buildLineDepths length equals maskStringContents line count for backslash-newline input", () => {
    const text = "const s = \"ab\\\ncd\";\n// START_BLOCK_REAL\nmore";
    const maskedLines = maskStringContents(text).split("\n").length;
    const depthsLen = buildLineDepths(text).length;
    expect(maskedLines).toBe(text.split("\n").length);
    expect(depthsLen).toBe(text.split("\n").length);
    expect(maskedLines).toBe(depthsLen);
  });
});
