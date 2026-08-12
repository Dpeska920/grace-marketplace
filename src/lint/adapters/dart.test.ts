import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import { createDartAdapter } from "./dart";

describe("Dart adapter", () => {
  const adapter = createDartAdapter();

  it("supports .dart files", () => {
    expect(adapter.supports("lib/foo.dart")).toBe(true);
    expect(adapter.supports("lib/foo.ts")).toBe(false);
  });

  it("extracts public top-level declarations", () => {
    const text = `
class UserService {}
mixin Serializable {}
enum Status { ok, fail }
extension StringHelper on String {}
typedef Builder = Widget Function();
String greet(String name) => "hi";
final String appName = "app";
`;
    const analysis = adapter.analyze("lib/user_service.dart", text);
    expect(analysis.adapterId).toBe("dart");
    expect(analysis.exportConfidence).toBe("heuristic");
    expect(analysis.exports.has("UserService")).toBe(true);
    expect(analysis.exports.has("Serializable")).toBe(true);
    expect(analysis.exports.has("Status")).toBe(true);
    expect(analysis.exports.has("StringHelper")).toBe(true);
    expect(analysis.exports.has("Builder")).toBe(true);
  });

  it("excludes private declarations (starting with _)", () => {
    const text = `
class _PrivateHelper {}
void _internalSetup() {}
class PublicClass {}
`;
    const analysis = adapter.analyze("lib/example.dart", text);
    expect(analysis.exports.has("_PrivateHelper")).toBe(false);
    expect(analysis.exports.has("_internalSetup")).toBe(false);
    expect(analysis.exports.has("PublicClass")).toBe(true);
  });

  it("detects test framework via import", () => {
    const text = `import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('renders widget', (tester) async {});
}
`;
    const analysis = adapter.analyze("test/widget_test.dart", text);
    expect(analysis.usesTestFramework).toBe(true);
  });

  it("detects test role from _test.dart file name", () => {
    const text = `void main() {}`;
    const analysis = adapter.analyze("test/user_service_test.dart", text);
    expect(analysis.usesTestFramework).toBe(true);
  });

  it("detects main entrypoint", () => {
    const text = `void main() { runApp(MyApp()); }`;
    const analysis = adapter.analyze("lib/main.dart", text);
    expect(analysis.hasMainEntrypoint).toBe(true);
  });

  it("returns empty exports for file with only private declarations", () => {
    const text = `
class _State {}
void _init() {}
`;
    const analysis = adapter.analyze("lib/internal.dart", text);
    expect(analysis.exports.size).toBe(0);
  });

  // BUG-3: indented class members must not appear as top-level exports (Dart)
  it("BUG-3: indented class members are not exported as top-level symbols", () => {
    const text = `class MyService {
  String greet(String name) => 'hi';
  final String version = '1.0';
}`;
    const analysis = adapter.analyze("lib/my_service.dart", text);
    expect(analysis.exports.has("MyService")).toBe(true);
    expect(analysis.exports.has("greet")).toBe(false);
    expect(analysis.exports.has("version")).toBe(false);
  });

  // NIT-6: switch/catch/await keyword guard
  it("NIT-6: does not export switch/catch/await as top-level function symbols", () => {
    const text = `
String doWork(dynamic x) {
  switch (x) {
    case 1: return 'one';
    default: return 'other';
  }
}
`;
    const analysis = adapter.analyze("lib/work.dart", text);
    expect(analysis.exports.has("switch")).toBe(false);
    expect(analysis.exports.has("catch")).toBe(false);
    expect(analysis.exports.has("await")).toBe(false);
  });

  // Coverage for fixed constructs: top-level getter, bare call (not exported), various return types
  it("exports top-level getter 'int get answer => 42'", () => {
    const text = `int get answer => 42;`;
    const analysis = adapter.analyze("lib/constants.dart", text);
    expect(analysis.exports.has("answer")).toBe(true);
  });

  it("does NOT export a bare top-level call expression (no return type, no body indicator)", () => {
    const text = `sideEffect();`;
    const analysis = adapter.analyze("lib/side.dart", text);
    expect(analysis.exports.has("sideEffect")).toBe(false);
    expect(analysis.exports.size).toBe(0);
  });

  it("exports void main(){}", () => {
    const text = `void main() {}`;
    const analysis = adapter.analyze("lib/main.dart", text);
    expect(analysis.exports.has("main")).toBe(true);
  });

  it("exports Future<int> f() async {}", () => {
    const text = `Future<int> f() async {}`;
    const analysis = adapter.analyze("lib/f.dart", text);
    expect(analysis.exports.has("f")).toBe(true);
  });

  it("exports String greet(String n) => 'hi'", () => {
    const text = `String greet(String n) => 'hi';`;
    const analysis = adapter.analyze("lib/greeter.dart", text);
    expect(analysis.exports.has("greet")).toBe(true);
  });

  it("bare export directive sets hasWildcardReExport=true", () => {
    const text = `export 'src/foo.dart';`;
    const analysis = adapter.analyze("lib/barrel.dart", text);
    expect(analysis.hasWildcardReExport).toBe(true);
    expect(analysis.exports.size).toBe(0);
  });

  it("export with 'show' clause exports the named symbols", () => {
    const text = `export 'x.dart' show A, B;`;
    const analysis = adapter.analyze("lib/barrel.dart", text);
    expect(analysis.exports.has("A")).toBe(true);
    expect(analysis.exports.has("B")).toBe(true);
    expect(analysis.hasWildcardReExport).toBe(false);
  });

  it("FIX-1 Dart: top-level declarations after triple-quoted string with unbalanced braces are exported", () => {
    const text = `
class Before {}

final t = '''
  This string has { unbalanced { braces
  and spans multiple lines
''';

class AfterString {}

String topLevelFn() => 'hello';
`;
    const analysis = adapter.analyze("lib/fix1.dart", text);
    expect(analysis.exports.has("Before")).toBe(true);
    expect(analysis.exports.has("AfterString")).toBe(true);
    expect(analysis.exports.has("topLevelFn")).toBe(true);
  });

  it("FIX-1 Dart: block comment with braces does not affect depth", () => {
    const text = `
class First {}
/* This comment has { unmatched brace */
class Second {}
`;
    const analysis = adapter.analyze("lib/fix1b.dart", text);
    expect(analysis.exports.has("First")).toBe(true);
    expect(analysis.exports.has("Second")).toBe(true);
  });

  it("includes a private top-level declaration in localSymbols but not in exports", () => {
    const text = `
class _PrivateHelper {}
class PublicClass {}
`;
    const analysis = adapter.analyze("lib/example.dart", text);
    expect(analysis.localSymbols.has("_PrivateHelper")).toBe(true);
    expect(analysis.exports.has("_PrivateHelper")).toBe(false);
    expect(analysis.exports.has("PublicClass")).toBe(true);
  });

  it("localSymbols is a superset of exports", () => {
    const text = `
class _Hidden {}
class Visible {}
export 'x.dart' show Reexported;
`;
    const analysis = adapter.analyze("lib/barrel.dart", text);
    for (const name of analysis.exports) {
      expect(analysis.localSymbols.has(name)).toBe(true);
    }
    expect(analysis.localSymbols.has("_Hidden")).toBe(true);
  });

  it("does not leak indented class members into top-level localSymbols", () => {
    const text = `class MyService {
  String greet(String name) => 'hi';
}`;
    const analysis = adapter.analyze("lib/my_service.dart", text);
    expect(analysis.localSymbols.has("MyService")).toBe(true);
    expect(analysis.localSymbols.has("greet")).toBe(false);
  });

  it("recognizes Dart 3 class-modifier combinations and captures the class name, not a modifier", () => {
    const cases: Array<[string, string]> = [
      ["base class Foo {}", "Foo"],
      ["final class Foo {}", "Foo"],
      ["interface class Foo {}", "Foo"],
      ["sealed class Foo {}", "Foo"],
      ["abstract base class Foo {}", "Foo"],
      ["abstract final class Foo {}", "Foo"],
      ["abstract interface class Foo {}", "Foo"],
      ["abstract class Foo {}", "Foo"],
      ["mixin class Foo {}", "Foo"],
      ["base mixin class Foo {}", "Foo"],
      ["base mixin Foo {}", "Foo"],
    ];
    for (const [decl, expectedName] of cases) {
      const analysis = adapter.analyze("lib/modifiers.dart", `${decl}\n`);
      expect(analysis.exports.has(expectedName)).toBe(true);
      expect(analysis.exports.has("class")).toBe(false);
      expect(analysis.exports.has("mixin")).toBe(false);
      expect(analysis.exports.has("base")).toBe(false);
      expect(analysis.exports.has("final")).toBe(false);
      expect(analysis.exports.has("interface")).toBe(false);
      expect(analysis.exports.has("sealed")).toBe(false);
      expect(analysis.exports.has("abstract")).toBe(false);
    }
  });

  it("recognizes extension type declarations (Dart 3.3)", () => {
    const text = `
extension type Meters(int value) {}
extension type const Kilometers(int value) {}
`;
    const analysis = adapter.analyze("lib/units.dart", text);
    expect(analysis.exports.has("Meters")).toBe(true);
    expect(analysis.exports.has("Kilometers")).toBe(true);
    expect(analysis.exports.has("type")).toBe(false);
    expect(analysis.exports.has("const")).toBe(false);
  });

  it("does not produce a symbol for an unnamed extension (extension on Type {})", () => {
    const text = `extension on String {}`;
    const analysis = adapter.analyze("lib/unnamed_extension.dart", text);
    expect(analysis.exports.has("on")).toBe(false);
    expect(analysis.exports.size).toBe(0);
    expect(analysis.localSymbols.size).toBe(0);
  });

  it("does not export a modified class nested inside another class body", () => {
    const text = `class Outer {
  final class Inner {}
}`;
    const analysis = adapter.analyze("lib/nested.dart", text);
    expect(analysis.exports.has("Outer")).toBe(true);
    expect(analysis.localSymbols.has("Inner")).toBe(false);
    expect(analysis.exports.has("Inner")).toBe(false);
  });

  it("puts a private modified class in localSymbols but not exports", () => {
    const text = `final class _PrivateFinal {}`;
    const analysis = adapter.analyze("lib/private_final.dart", text);
    expect(analysis.localSymbols.has("_PrivateFinal")).toBe(true);
    expect(analysis.exports.has("_PrivateFinal")).toBe(false);
  });

  it("does not invoke an external dart binary via subprocess", () => {
    const source = readFileSync(new URL("./dart.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bspawnSync\b/);
    expect(source).not.toMatch(/\bspawn\(/);
    expect(source).not.toMatch(/\bexecSync\b/);
    expect(source).not.toMatch(/\bmkdtempSync\b/);
    expect(source).not.toMatch(/from\s+["']node:child_process["']/);
  });
});
