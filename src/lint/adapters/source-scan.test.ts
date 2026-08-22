// START_MODULE_CONTRACT
//   ROLE: TEST
//   PURPOSE: Unit tests for the buildLineDepths state-machine in source-scan.ts.
//   SCOPE: Edge cases: triple-quoted strings, escape sequences, comment disambiguation,
//          block comments, unclosed states, mixed quotes.
//   DEPENDS: source-scan
//   LINKS: M-LINT-ADAPTERS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MAP_MODE: NONE
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [remove string-masking helper test coverage - function had no callers, deleted]
// END_CHANGE_SUMMARY

import { describe, expect, it } from "bun:test";

import { buildLineDepths } from "./source-scan";

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

  // --- Dart raw strings (r'...' / R"...") ---

  it("raw string r'\\' (a single backslash) does not hide a following top-level main", () => {
    // Dart raw string: backslash is literal, NOT an escape. r'\' is a string
    // containing ONE backslash; the closing quote must not be consumed by
    // escape handling (which would desync the scanner and swallow later
    // braces/parens, shifting every following depth).
    const text = [
      "void helper() {",
      "  if (c == r'\\') {",
      "    // inside",
      "  }",
      "}",
      "void main() {",
      "  print('hi');",
      "}",
    ].join("\n");
    const d = depths(text);
    expect(d[5]).toBe(0); // main — top-level, extracted
  });

  it('raw string r"..." with a backslash likewise does not hide a following top-level main', () => {
    const text = [
      "void helper() {",
      '  var s = r"\\";',
      "}",
      "void main() {",
    ].join("\n");
    const d = depths(text);
    expect(d[3]).toBe(0);
  });

  it("raw string is closed by its own quote: braces after it still count", () => {
    // r'x' closes at its own quote; the { after it must increment depth.
    const text = "var a = r'x'; {\n  fun()";
    const d = depths(text);
    expect(d[1]).toBe(1);
  });

  it("uppercase R'\\' raw string is recognized and closes at its own quote", () => {
    const text = "var a = R'\\'; {\nclass After";
    const d = depths(text);
    expect(d[1]).toBe(1);
  });

  it("r''' raw triple string falls through to triple-quote handling (escapes already ignored)", () => {
    const text = "var s = r'''\n  { ignored {\n'''\nclass After";
    const d = depths(text);
    expect(d[3]).toBe(0);
  });

  it("non-raw identifier ending in r followed by a quote is NOT misread as a raw string", () => {
    // `var r = 'x'` — the `r` is a plain identifier, not a raw-string prefix.
    // The following 'x' is a regular string: escape handling still applies.
    const text = "var r = 'x';\nclass After";
    const d = depths(text);
    expect(d[1]).toBe(0);
  });

  it("identifier char directly before r (arr'x') prevents raw-string detection", () => {
    // The r in `arr'x'` is preceded by an identifier char, so it is not a
    // raw-string prefix — the 'x' is a regular single-quoted string.
    const text = "var arr'x';\nclass After";
    const d = depths(text);
    expect(d[1]).toBe(0);
  });
});
