// START_MODULE_CONTRACT
//   ROLE: TEST
//   PURPOSE: Unit tests for Dart, Kotlin, Swift, Vue, and Python language adapters.
//   SCOPE: Export extraction, privacy rules, test-role detection, MODULE_MAP parity.
//   DEPENDS: dart, kotlin, swift, vue, python, typescript adapters
//   LINKS: M-LINT-ADAPTERS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MAP_MODE: NONE
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.5.1 - add: Kotlin nested-generic tests; Vue destructuring + import-exclusion tests]
// END_CHANGE_SUMMARY

import { describe, expect, it } from "bun:test";

import { createDartAdapter } from "./dart";
import { createKotlinAdapter } from "./kotlin";
import { createPythonAdapter } from "./python";
import { createSwiftAdapter } from "./swift";
import { createVueAdapter } from "./vue";

// ---------------------------------------------------------------------------
// Dart adapter
// ---------------------------------------------------------------------------

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
});

// ---------------------------------------------------------------------------
// Kotlin adapter
// ---------------------------------------------------------------------------

describe("Kotlin adapter", () => {
  const adapter = createKotlinAdapter();

  it("supports .kt and .kts files", () => {
    expect(adapter.supports("src/Foo.kt")).toBe(true);
    expect(adapter.supports("build.gradle.kts")).toBe(true);
    expect(adapter.supports("src/Foo.java")).toBe(false);
  });

  it("extracts public top-level declarations", () => {
    const text = `
class UserRepository
object AppConfig
interface PaymentGateway
fun greet(name: String): String = "hi"
val APP_NAME = "app"
enum class Status { OK, FAIL }
typealias Callback = () -> Unit
`;
    const analysis = adapter.analyze("src/UserRepository.kt", text);
    expect(analysis.adapterId).toBe("kotlin");
    expect(analysis.exportConfidence).toBe("heuristic");
    expect(analysis.exports.has("UserRepository")).toBe(true);
    expect(analysis.exports.has("AppConfig")).toBe(true);
    expect(analysis.exports.has("PaymentGateway")).toBe(true);
    expect(analysis.exports.has("greet")).toBe(true);
    expect(analysis.exports.has("APP_NAME")).toBe(true);
    expect(analysis.exports.has("Status")).toBe(true);
    expect(analysis.exports.has("Callback")).toBe(true);
  });

  it("excludes private and internal declarations", () => {
    const text = `
private class _Hidden {}
internal class InternalHelper {}
protected fun protectedFun() {}
class PublicClass
`;
    const analysis = adapter.analyze("src/Mixed.kt", text);
    expect(analysis.exports.has("_Hidden")).toBe(false);
    expect(analysis.exports.has("InternalHelper")).toBe(false);
    expect(analysis.exports.has("protectedFun")).toBe(false);
    expect(analysis.exports.has("PublicClass")).toBe(true);
  });

  it("detects test framework via import", () => {
    const text = `
import org.junit.Test
import org.junit.Assert.*

class UserRepositoryTest {
  @Test
  fun testFind() {}
}
`;
    const analysis = adapter.analyze("src/UserRepositoryTest.kt", text);
    expect(analysis.usesTestFramework).toBe(true);
  });

  it("detects @Test annotation as test framework indicator", () => {
    const text = `
import kotlin.test.Test

class SomeTest {
  @Test
  fun shouldPass() {}
}
`;
    const analysis = adapter.analyze("src/SomeTest.kt", text);
    expect(analysis.usesTestFramework).toBe(true);
  });

  it("detects fun main as entrypoint in .kt", () => {
    const text = `fun main(args: Array<String>) { println("hi") }`;
    const analysis = adapter.analyze("src/Main.kt", text);
    expect(analysis.hasMainEntrypoint).toBe(true);
  });

  it("detects fun main as entrypoint in .kts", () => {
    const text = `fun main() { println("hello") }`;
    const analysis = adapter.analyze("script.kts", text);
    expect(analysis.hasMainEntrypoint).toBe(true);
  });

  it("FIX-E-2: .kts with a top-level println statement IS hasMainEntrypoint", () => {
    const text = `println("hi")`;
    const analysis = adapter.analyze("script.kts", text);
    expect(analysis.hasMainEntrypoint).toBe(true);
  });

  it("FIX-E-2: plain .kt library file with no main is NOT hasMainEntrypoint", () => {
    const text = [
      "class MyService {",
      "    fun doWork() {}",
      "}",
      "val VERSION = \"1.0\"",
    ].join("\n");
    const analysis = adapter.analyze("src/MyService.kt", text);
    expect(analysis.hasMainEntrypoint).toBe(false);
  });

  // BUG-1: private constructor parameter should not suppress public class export.
  // Realistic multi-line constructor: each param on its own line (previously caused param names
  // to be seen as depth-0 declarations before the buildLineDepths fix).
  it("BUG-1: exports public class with multi-line constructor containing private parameter", () => {
    const text = [
      "class Repo(",
      "  private val db: Db,",
      "  val name: String",
      ")",
    ].join("\n");
    const analysis = adapter.analyze("src/Repo.kt", text);
    expect(analysis.exports.has("Repo")).toBe(true);
    // Private constructor param must not appear as a top-level export
    expect(analysis.exports.has("db")).toBe(false);
    // Public constructor param must also not appear as a top-level export
    expect(analysis.exports.has("name")).toBe(false);
  });

  it("BUG-1: exports data class with multi-line mixed-visibility constructor", () => {
    const text = [
      "data class User(",
      "  val id: Int,",
      "  private val secret: String",
      ")",
    ].join("\n");
    const analysis = adapter.analyze("src/User.kt", text);
    expect(analysis.exports.has("User")).toBe(true);
    expect(analysis.exports.has("id")).toBe(false);
    expect(analysis.exports.has("secret")).toBe(false);
  });

  // BUG-3: indented members must not appear as top-level exports (Kotlin)
  it("BUG-3: indented class members are not exported as top-level symbols", () => {
    const text = `class MyService {
    fun doWork() {}
    val config = "cfg"
}`;
    const analysis = adapter.analyze("src/MyService.kt", text);
    expect(analysis.exports.has("MyService")).toBe(true);
    expect(analysis.exports.has("doWork")).toBe(false);
    expect(analysis.exports.has("config")).toBe(false);
  });

  // FIX-1: Kotlin triple-quoted string with unbalanced braces must not confuse depth tracking
  it("FIX-1 Kotlin: top-level declarations after triple-quoted string with unbalanced braces are exported", () => {
    const text = `
class Before

val t = """
  template with { unbalanced { braces
  spanning multiple lines
"""

class AfterString

fun topLevelFn(): String = "hi"
`;
    const analysis = adapter.analyze("src/fix1.kt", text);
    expect(analysis.exports.has("Before")).toBe(true);
    expect(analysis.exports.has("AfterString")).toBe(true);
    expect(analysis.exports.has("topLevelFn")).toBe(true);
  });

  it("FIX-1 Kotlin: block comment with braces does not affect depth", () => {
    const text = `
class First
/* block comment with { unmatched brace */
class Second
`;
    const analysis = adapter.analyze("src/fix1b.kt", text);
    expect(analysis.exports.has("First")).toBe(true);
    expect(analysis.exports.has("Second")).toBe(true);
  });

  // FIX-3: same-line annotation must not suppress Kotlin declaration export
  it("FIX-3: @Serializable class Config is exported", () => {
    const text = `@Serializable class Config(val host: String)`;
    const analysis = adapter.analyze("src/Config.kt", text);
    expect(analysis.exports.has("Config")).toBe(true);
  });

  it("FIX-3: @JvmStatic fun helper() is exported", () => {
    const text = `@JvmStatic fun helper(): String = "hi"`;
    const analysis = adapter.analyze("src/Helper.kt", text);
    expect(analysis.exports.has("helper")).toBe(true);
  });

  it("FIX-3: multi-annotation same-line declaration is exported", () => {
    const text = `@Suppress("UNCHECKED_CAST") @JvmField val INSTANCE: Any = Any()`;
    const analysis = adapter.analyze("src/Instance.kt", text);
    expect(analysis.exports.has("INSTANCE")).toBe(true);
  });

  // FIX-D: const val / expect / actual / named companion object
  it("FIX-D: top-level const val exports the name", () => {
    const text = `const val MAX_RETRIES = 3`;
    const analysis = adapter.analyze("src/Constants.kt", text);
    expect(analysis.exports.has("MAX_RETRIES")).toBe(true);
  });

  it("FIX-D: expect class exports the class name", () => {
    const text = `expect class Engine`;
    const analysis = adapter.analyze("src/Engine.kt", text);
    expect(analysis.exports.has("Engine")).toBe(true);
  });

  it("FIX-D: actual fun exports the function name", () => {
    const text = `actual fun build(): Engine = Engine()`;
    const analysis = adapter.analyze("src/Engine.kt", text);
    expect(analysis.exports.has("build")).toBe(true);
  });

  it("FIX-D: named companion object Factory exports Factory", () => {
    const text = `class Foo {\n    companion object Factory\n}`;
    const analysis = adapter.analyze("src/Foo.kt", text);
    // companion object Factory is inside a class (depth > 0), so it is NOT exported as top-level
    expect(analysis.exports.has("Factory")).toBe(false);
    expect(analysis.exports.has("Foo")).toBe(true);
  });

  // A top-level companion object is invalid Kotlin syntax (companion objects only exist inside
  // a class). The in-class case is already verified above (Factory is NOT a top-level export).
  // No test for an invalid top-level companion object is included.

  // FIX-E: .kts main-entrypoint gate
  it("FIX-E: .kts with fun main is hasMainEntrypoint", () => {
    const text = `fun main() { println("hello") }`;
    const analysis = adapter.analyze("script.kts", text);
    expect(analysis.hasMainEntrypoint).toBe(true);
  });

  it("FIX-E: .kts with top-level executable statement is hasMainEntrypoint", () => {
    const text = `println("hello")`;
    const analysis = adapter.analyze("script.kts", text);
    expect(analysis.hasMainEntrypoint).toBe(true);
  });

  // FIX-A: nested-paren annotation strip (red tests — nested parens break old regex)
  it("FIX-A: @Foo(bar(1)) class Config is exported", () => {
    const text = `@Foo(bar(1)) class Config`;
    const analysis = adapter.analyze("src/Config.kt", text);
    expect(analysis.exports.has("Config")).toBe(true);
  });

  it("FIX-A: @Inject(named(\"db\")) class Repo is exported", () => {
    const text = `@Inject(named("db")) class Repo`;
    const analysis = adapter.analyze("src/Repo.kt", text);
    expect(analysis.exports.has("Repo")).toBe(true);
  });

  it("FIX-A: @RequiresApi(Build.VERSION_CODES.O) fun f is exported", () => {
    const text = `@RequiresApi(Build.VERSION_CODES.O) fun f(): Unit {}`;
    const analysis = adapter.analyze("src/F.kt", text);
    expect(analysis.exports.has("f")).toBe(true);
  });

  it("FIX-A: multiple annotations with nested parens — @A @B(c(1)) class X is exported", () => {
    const text = `@A @B(c(1)) class X`;
    const analysis = adapter.analyze("src/X.kt", text);
    expect(analysis.exports.has("X")).toBe(true);
  });

  it("FIX-A: @Inject private val secret is NOT exported (privacy gate preserved)", () => {
    const text = `@Inject private val secret: String = ""`;
    const analysis = adapter.analyze("src/Secrets.kt", text);
    expect(analysis.exports.has("secret")).toBe(false);
  });

  // FIX-2: multi-line constructor — constructor params must NOT leak as top-level exports
  it("FIX-2: multi-line constructor params are NOT exported as top-level symbols", () => {
    const text = `class Repo(\n  val db: Db,\n  val name: String\n)\nfun helper() {}`;
    const analysis = adapter.analyze("src/Repo.kt", text);
    expect(analysis.exports.has("Repo")).toBe(true);     // class itself is exported
    expect(analysis.exports.has("db")).toBe(false);      // constructor param must not leak
    expect(analysis.exports.has("name")).toBe(false);    // constructor param must not leak
    expect(analysis.exports.has("helper")).toBe(true);   // subsequent top-level decl still works
  });

  // Coverage for fixed constructs: extension functions, generic functions, annotation class
  it("extension function 'fun List<T>.foo()' exports 'foo', not 'List'", () => {
    const text = `fun <T> List<T>.foo(): List<T> = this`;
    const analysis = adapter.analyze("src/Extensions.kt", text);
    expect(analysis.exports.has("foo")).toBe(true);
    expect(analysis.exports.has("List")).toBe(false);
  });

  it("generic top-level function 'fun <T> id(x: T): T = x' exports 'id'", () => {
    const text = `fun <T> id(x: T): T = x`;
    const analysis = adapter.analyze("src/Id.kt", text);
    expect(analysis.exports.has("id")).toBe(true);
  });

  it("annotation class 'annotation class Marker' exports 'Marker'", () => {
    const text = `annotation class Marker`;
    const analysis = adapter.analyze("src/Marker.kt", text);
    expect(analysis.exports.has("Marker")).toBe(true);
  });

  // FIX-NESTED-GENERIC: single-level nested angle brackets in type param
  it("FIX-NESTED-GENERIC: 'fun <T> id(x: T)' exports 'id'", () => {
    const text = `fun <T> id(x: T): T = x`;
    const analysis = adapter.analyze("src/Id.kt", text);
    expect(analysis.exports.has("id")).toBe(true);
  });

  it("FIX-NESTED-GENERIC: 'fun <T : Comparable<T>> maxOf(a: T, b: T): T' exports 'maxOf'", () => {
    const text = `fun <T : Comparable<T>> maxOf(a: T, b: T): T = if (a > b) a else b`;
    const analysis = adapter.analyze("src/MaxOf.kt", text);
    expect(analysis.exports.has("maxOf")).toBe(true);
  });

  it("FIX-NESTED-GENERIC: 'fun <T : List<String>> firstOf(list: T): String' exports 'firstOf'", () => {
    const text = `fun <T : List<String>> firstOf(list: T): String = list.first()`;
    const analysis = adapter.analyze("src/FirstOf.kt", text);
    expect(analysis.exports.has("firstOf")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Swift adapter
// ---------------------------------------------------------------------------

describe("Swift adapter", () => {
  const adapter = createSwiftAdapter();

  it("supports .swift files", () => {
    expect(adapter.supports("Sources/Foo.swift")).toBe(true);
    expect(adapter.supports("Sources/Foo.kt")).toBe(false);
  });

  it("extracts public and open declarations", () => {
    const text = `
public class AuthService {}
open class BaseController {}
public struct Point {}
public enum Direction { case north, south }
public protocol Serializable {}
public func greet() -> String { "hi" }
public let VERSION = "1.0"
public typealias Handler = () -> Void
`;
    const analysis = adapter.analyze("Sources/AuthService.swift", text);
    expect(analysis.adapterId).toBe("swift");
    expect(analysis.exportConfidence).toBe("heuristic");
    expect(analysis.exports.has("AuthService")).toBe(true);
    expect(analysis.exports.has("BaseController")).toBe(true);
    expect(analysis.exports.has("Point")).toBe(true);
    expect(analysis.exports.has("Direction")).toBe(true);
    expect(analysis.exports.has("Serializable")).toBe(true);
    expect(analysis.exports.has("greet")).toBe(true);
    expect(analysis.exports.has("VERSION")).toBe(true);
    expect(analysis.exports.has("Handler")).toBe(true);
  });

  it("excludes internal, private, and fileprivate declarations", () => {
    const text = `
class InternalClass {}
private class PrivateClass {}
fileprivate struct FPStruct {}
public class PublicClass {}
`;
    const analysis = adapter.analyze("Sources/Mixed.swift", text);
    expect(analysis.exports.has("InternalClass")).toBe(false);
    expect(analysis.exports.has("PrivateClass")).toBe(false);
    expect(analysis.exports.has("FPStruct")).toBe(false);
    expect(analysis.exports.has("PublicClass")).toBe(true);
  });

  it("detects XCTest test framework", () => {
    const text = `
import XCTest

class AuthTests: XCTestCase {
  func testLogin() {}
}
`;
    const analysis = adapter.analyze("Tests/AuthTests.swift", text);
    expect(analysis.usesTestFramework).toBe(true);
  });

  it("detects @Test annotation from Swift Testing framework", () => {
    const text = `
import Testing

struct AuthSuite {
  @Test func loginSucceeds() {}
}
`;
    const analysis = adapter.analyze("Tests/AuthSuite.swift", text);
    expect(analysis.usesTestFramework).toBe(true);
  });

  it("detects func test* pattern as test indicator", () => {
    const text = `
import XCTest

class Specs: XCTestCase {
  func testFoo() {}
}
`;
    const analysis = adapter.analyze("Tests/Specs.swift", text);
    expect(analysis.usesTestFramework).toBe(true);
  });

  it("returns empty exports when no public declarations", () => {
    const text = `
class InternalService {}
func privateHelper() {}
`;
    const analysis = adapter.analyze("Sources/Internal.swift", text);
    expect(analysis.exports.size).toBe(0);
  });

  // BUG-4: public private(set) var should be exported
  it("BUG-4: exports public property with private(set) accessor modifier", () => {
    const text = `public private(set) var count: Int = 0`;
    const analysis = adapter.analyze("Sources/Counter.swift", text);
    expect(analysis.exports.has("count")).toBe(true);
  });

  it("BUG-4: exports public property with fileprivate(set) accessor modifier", () => {
    const text = `public fileprivate(set) var total: Double = 0.0`;
    const analysis = adapter.analyze("Sources/Stats.swift", text);
    expect(analysis.exports.has("total")).toBe(true);
  });

  // FIX-2: Swift brace-depth tracking — members inside a type must not be exported
  it("FIX-2 Swift: public var inside private struct is not exported as top-level", () => {
    const text = `
private struct Outer {
  public var leak: Int = 0
}
public struct Visible {}
`;
    const analysis = adapter.analyze("Sources/Fix2.swift", text);
    expect(analysis.exports.has("leak")).toBe(false);
    expect(analysis.exports.has("Visible")).toBe(true);
  });

  it("FIX-2 Swift: public func inside public class is not re-exported as top-level", () => {
    const text = `
public class Container {
  public func inner() {}
}
public func standalone() {}
`;
    const analysis = adapter.analyze("Sources/Fix2b.swift", text);
    expect(analysis.exports.has("inner")).toBe(false);
    expect(analysis.exports.has("Container")).toBe(true);
    expect(analysis.exports.has("standalone")).toBe(true);
  });

  // FIX-B: leading-attribute declarations must be exported
  it("FIX-B: @objc public func foo() is exported", () => {
    const text = `@objc public func foo() {}`;
    const analysis = adapter.analyze("Sources/Foo.swift", text);
    expect(analysis.exports.has("foo")).toBe(true);
  });

  it("FIX-B: @MainActor public class Bar is exported", () => {
    const text = `@MainActor public class Bar {}`;
    const analysis = adapter.analyze("Sources/Bar.swift", text);
    expect(analysis.exports.has("Bar")).toBe(true);
  });

  it("FIX-B: @available(iOS 14, *) public struct Baz is exported", () => {
    const text = `@available(iOS 14, *) public struct Baz {}`;
    const analysis = adapter.analyze("Sources/Baz.swift", text);
    expect(analysis.exports.has("Baz")).toBe(true);
  });

  it("FIX-B: pure @available(...) line with no declaration is skipped (not exported)", () => {
    const text = `@available(iOS 14, *)
public struct After {}`;
    const analysis = adapter.analyze("Sources/After.swift", text);
    expect(analysis.exports.has("After")).toBe(true);
    // The @available line alone should NOT produce a spurious export
    expect(analysis.exports.size).toBe(1);
  });

  // FIX-C: production func test* must NOT set usesTestFramework without a real test signal
  it("FIX-C: production func testConnection() without XCTest import does NOT set usesTestFramework", () => {
    const text = `
public class NetworkClient {
  public func testConnection() -> Bool { return true }
  public func testReachability() -> Bool { return true }
}
`;
    const analysis = adapter.analyze("Sources/NetworkClient.swift", text);
    expect(analysis.usesTestFramework).toBe(false);
  });

  it("FIX-C: import XCTest + class : XCTestCase DOES set usesTestFramework", () => {
    const text = `
import XCTest

class NetworkTests: XCTestCase {
  func testConnection() {}
}
`;
    const analysis = adapter.analyze("Tests/NetworkTests.swift", text);
    expect(analysis.usesTestFramework).toBe(true);
  });

  // Coverage for fixed constructs: init?, subscript, operator func, public extension members
  it("exports stable 'init' symbol for 'public init?(x: Int){}'", () => {
    const text = `public init?(x: Int) {}`;
    const analysis = adapter.analyze("Sources/Foo.swift", text);
    expect(analysis.exports.has("init")).toBe(true);
  });

  it("exports 'subscript' for 'public subscript(i: Int) -> Int { 0 }'", () => {
    const text = `public subscript(i: Int) -> Int { 0 }`;
    const analysis = adapter.analyze("Sources/Coll.swift", text);
    expect(analysis.exports.has("subscript")).toBe(true);
  });

  it("exports operator name '+' for 'public static func + (l:V,r:V)->V{l}'", () => {
    const text = `public static func + (l: V, r: V) -> V { l }`;
    const analysis = adapter.analyze("Sources/Vector.swift", text);
    expect(analysis.exports.has("+")).toBe(true);
  });

  it("public extension with multi-line body exports member names, NOT the extended type", () => {
    const text = `public extension Array {
  public func chunked(by size: Int) -> [[Element]] { [] }
  public var firstOrNil: Element? { first }
}`;
    const analysis = adapter.analyze("Sources/ArrayExt.swift", text);
    expect(analysis.exports.has("chunked")).toBe(true);
    expect(analysis.exports.has("firstOrNil")).toBe(true);
    // The extended type 'Array' must NOT appear as a top-level export
    expect(analysis.exports.has("Array")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Vue adapter
// ---------------------------------------------------------------------------

describe("Vue adapter", () => {
  const adapter = createVueAdapter();

  it("supports .vue files", () => {
    expect(adapter.supports("src/MyComponent.vue")).toBe(true);
    expect(adapter.supports("src/MyComponent.ts")).toBe(false);
  });

  it("extracts named exports from <script> block", () => {
    const text = `<template><div>Hello</div></template>
<script lang="ts">
export function greet(): string { return "hi"; }
export const VERSION = "1.0";
</script>
<style scoped></style>
`;
    const analysis = adapter.analyze("src/MyComponent.vue", text);
    expect(analysis.adapterId).toBe("vue");
    expect(analysis.exportConfidence).toBe("heuristic");
    expect(analysis.exports.has("greet")).toBe(true);
    expect(analysis.exports.has("VERSION")).toBe(true);
  });

  it("extracts exports from <script setup> block", () => {
    const text = `<template><div>{{ msg }}</div></template>
<script setup lang="ts">
export const msg = "hello";
export function doSomething() {}
</script>
`;
    const analysis = adapter.analyze("src/SetupComponent.vue", text);
    expect(analysis.exports.has("msg")).toBe(true);
    expect(analysis.exports.has("doSomething")).toBe(true);
  });

  it("returns empty analysis for .vue file with no script block", () => {
    const text = `<template><div>Static</div></template>`;
    const analysis = adapter.analyze("src/Static.vue", text);
    expect(analysis.adapterId).toBe("vue");
    expect(analysis.exportConfidence).toBe("heuristic");
    expect(analysis.exports.size).toBe(0);
  });

  it("keeps heuristic confidence even when script content is parseable exactly, and still extracts export", () => {
    const text = `<script>export function run() {}</script>`;
    const analysis = adapter.analyze("src/Comp.vue", text);
    // Vue SFC always stays heuristic due to implicit <script setup> bindings.
    expect(analysis.exportConfidence).toBe("heuristic");
    // Must also actually extract the exported symbol — not a tautology check
    expect(analysis.exports.has("run")).toBe(true);
    expect(analysis.exports.size).toBe(1);
  });

  // BUG-2: both script blocks in a dual-block SFC must be analysed
  it("BUG-2: extracts exports from both <script setup> and <script> blocks", () => {
    const text = `<template><div>hi</div></template>
<script setup lang="ts">
export const setupExport = "setup";
</script>
<script lang="ts">
export function regularExport() {}
</script>
`;
    const analysis = adapter.analyze("src/Dual.vue", text);
    expect(analysis.exports.has("setupExport")).toBe(true);
    expect(analysis.exports.has("regularExport")).toBe(true);
  });

  // BUG-2: src= blocks should be ignored (no inline content)
  it("BUG-2: ignores <script src=...> external script block", () => {
    const text = `<template><div>hi</div></template>
<script src="./external.js"></script>
`;
    const analysis = adapter.analyze("src/External.vue", text);
    expect(analysis.exports.size).toBe(0);
  });

  // Coverage for fixed constructs: <script setup> auto-exposed bindings + defineExpose
  it("<script setup> with top-level bindings and defineExpose exports all three surfaces", () => {
    const text = `<template><div>{{ msg }}</div></template>
<script setup lang="ts">
import { ref } from 'vue';
const msg = ref('');
function onClick() {}
const reset = () => {};
defineExpose({ reset });
</script>
`;
    const analysis = adapter.analyze("src/MyComp.vue", text);
    // top-level binding — auto-exposed by <script setup>
    expect(analysis.exports.has("msg")).toBe(true);
    // top-level function — auto-exposed
    expect(analysis.exports.has("onClick")).toBe(true);
    // listed in defineExpose — must appear
    expect(analysis.exports.has("reset")).toBe(true);
  });

  it("<script> block (not setup) with 'export const x = 1' exports x", () => {
    const text = `<template><div>hi</div></template>
<script lang="ts">
export const x = 1;
</script>
`;
    const analysis = adapter.analyze("src/Const.vue", text);
    expect(analysis.exports.has("x")).toBe(true);
  });

  // FIX-VUE-DESTRUCTURE: object and array destructuring in <script setup>
  it("FIX-VUE-DESTRUCTURE: 'const { data } = useQuery()' in <script setup> exports 'data'", () => {
    const text = `<template><div>{{ data }}</div></template>
<script setup lang="ts">
const { data } = useQuery();
const [first] = useList();
</script>
`;
    const analysis = adapter.analyze("src/Destruct.vue", text);
    expect(analysis.exports.has("data")).toBe(true);
    expect(analysis.exports.has("first")).toBe(true);
  });

  it("FIX-VUE-DESTRUCTURE: renamed destructuring '{ data: renamed }' exports 'renamed', not 'data'", () => {
    const text = `<template><div></div></template>
<script setup lang="ts">
const { data: renamed } = useQuery();
</script>
`;
    const analysis = adapter.analyze("src/Renamed.vue", text);
    expect(analysis.exports.has("renamed")).toBe(true);
    expect(analysis.exports.has("data")).toBe(false);
  });

  it("FIX-VUE-IMPORTS: imported name 'ref' is NOT exported; local binding 'x' IS exported", () => {
    const text = `<template><div></div></template>
<script setup lang="ts">
import { ref } from 'vue';
const x = ref();
</script>
`;
    const analysis = adapter.analyze("src/ImportCheck.vue", text);
    expect(analysis.exports.has("ref")).toBe(false);
    expect(analysis.exports.has("x")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Python adapter
// ---------------------------------------------------------------------------

describe("Python adapter", () => {
  const adapter = createPythonAdapter();

  it("supports .py files", () => {
    expect(adapter.supports("src/foo.py")).toBe(true);
    expect(adapter.supports("src/foo.ts")).toBe(false);
  });

  // FIX-F: bare test_* naming must not set usesTestFramework without a real test signal
  it("FIX-F: def test_foo() alone (no pytest/unittest import) does NOT set usesTestFramework", () => {
    const text = `
def test_foo():
    pass

def regular():
    pass
`;
    const analysis = adapter.analyze("src/helpers.py", text);
    expect(analysis.usesTestFramework).toBe(false);
  });

  it("FIX-F: import pytest + def test_foo() DOES set usesTestFramework", () => {
    const text = `
import pytest

def test_foo():
    assert True
`;
    const analysis = adapter.analyze("tests/test_helpers.py", text);
    expect(analysis.usesTestFramework).toBe(true);
  });

  it("FIX-F: Test-prefixed class without unittest import does NOT set usesTestFramework", () => {
    const text = `
class TestHelpers:
    def check(self):
        pass
`;
    const analysis = adapter.analyze("src/test_helpers.py", text);
    expect(analysis.usesTestFramework).toBe(false);
  });

  it("FIX-F: import unittest + class TestFoo DOES set usesTestFramework", () => {
    const text = `
import unittest

class TestFoo(unittest.TestCase):
    def test_bar(self):
        self.assertTrue(True)
`;
    const analysis = adapter.analyze("tests/test_foo.py", text);
    expect(analysis.usesTestFramework).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MODULE_MAP parity integration (via lintGraceProject)
// ---------------------------------------------------------------------------

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { lintGraceProject } from "../../grace-lint";

function createProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grace-lint-adapter-"));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  return root;
}

function writeFile(root: string, rel: string, content: string) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function writeDocs(root: string) {
  writeFile(
    root,
    "docs/technology.xml",
    `<TechnologyStack VERSION="0.1.0">
  <Runtime>bun 1.x</Runtime>
  <Language>typescript 6.x</Language>
  <AutonomyPolicy>
    <default-execution-profile>balanced</default-execution-profile>
    <max-fix-attempts-per-step>2</max-fix-attempts-per-step>
  </AutonomyPolicy>
</TechnologyStack>`,
  );

  writeFile(
    root,
    "docs/knowledge-graph.xml",
    `<KnowledgeGraph>
  <Project NAME="Example" VERSION="0.1.0">
    <M-EXAMPLE NAME="Example" TYPE="CORE_LOGIC">
      <purpose>Adapter parity tests.</purpose>
      <path>src/example.ts</path>
      <depends>none</depends>
      <verification-ref>V-M-EXAMPLE</verification-ref>
    </M-EXAMPLE>
  </Project>
</KnowledgeGraph>`,
  );

  writeFile(
    root,
    "docs/development-plan.xml",
    `<DevelopmentPlan VERSION="0.1.0">
  <Modules>
    <M-EXAMPLE NAME="Example" TYPE="CORE_LOGIC" STATUS="planned">
      <contract><purpose>Adapter parity tests.</purpose></contract>
      <verification-ref>V-M-EXAMPLE</verification-ref>
    </M-EXAMPLE>
  </Modules>
  <ImplementationOrder>
    <Phase-1 name="Foundation" status="pending">
      <step-1 module="M-EXAMPLE" status="pending" verification="V-M-EXAMPLE">Implement.</step-1>
    </Phase-1>
  </ImplementationOrder>
</DevelopmentPlan>`,
  );

  writeFile(
    root,
    "docs/verification-plan.xml",
    `<VerificationPlan VERSION="0.1.0">
  <GlobalPolicy><module-level-focus>unit</module-level-focus></GlobalPolicy>
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files><file-1>src/example.test.ts</file-1></test-files>
      <module-checks><command-1>bun test</command-1></module-checks>
      <scenarios><scenario-1 kind="success">ok</scenario-1></scenarios>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`,
  );

  writeFile(
    root,
    "docs/operational-packets.xml",
    `<OperationalPackets VERSION="0.1.0">
  <ExecutionPacketTemplate><ExecutionPacket /></ExecutionPacketTemplate>
  <GraphDeltaTemplate><GraphDelta /></GraphDeltaTemplate>
  <VerificationDeltaTemplate><VerificationDelta /></VerificationDeltaTemplate>
  <FailurePacketTemplate><FailurePacket /></FailurePacketTemplate>
  <CheckpointReportTemplate><CheckpointReport /></CheckpointReportTemplate>
</OperationalPackets>`,
  );

  writeFile(
    root,
    "src/example.ts",
    `// START_MODULE_CONTRACT
//   PURPOSE: Adapter parity tests.
//   SCOPE: Entry point.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   run - Execute the example flow.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0]
// END_CHANGE_SUMMARY
export function run() { return "ok"; }
`,
  );
}

describe("MODULE_MAP parity via lintGraceProject", () => {
  it("suppresses extra-export for heuristic Dart adapter, emits only heuristic advisory", () => {
    const root = createProject();
    writeDocs(root);

    writeFile(
      root,
      "src/greeter.dart",
      `// START_MODULE_CONTRACT
//   PURPOSE: Dart greeter.
//   SCOPE: Expose greeting function.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   greet - Greet the user.
//   missingSymbol - Does not exist.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0]
// END_CHANGE_SUMMARY

String greet(String name) => 'hi $name';
`,
    );

    const result = lintGraceProject(root);
    const dartIssues = result.issues.filter((i) => i.file === "src/greeter.dart");
    const codes = dartIssues.map((i) => i.code);
    // Dart uses a heuristic adapter — extra-export is suppressed (same as missing-export).
    // Only the single per-file heuristic advisory is emitted; no per-symbol noise.
    expect(codes).not.toContain("markup.module-map-extra-export");
    expect(codes).toContain("analysis.heuristic-export-surface");
  });

  it("passes clean Kotlin file with correct MODULE_MAP", () => {
    const root = createProject();
    writeDocs(root);

    writeFile(
      root,
      "src/Greeter.kt",
      `// START_MODULE_CONTRACT
//   PURPOSE: Kotlin greeter.
//   SCOPE: Expose greeting function.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   greet - Greet the user.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0]
// END_CHANGE_SUMMARY

fun greet(name: String): String = "hi $name"
`,
    );

    const result = lintGraceProject(root);
    // Only heuristic warning expected, no extra-export or missing-export
    const kotlinIssues = result.issues.filter(
      (i) => i.file === "src/Greeter.kt" && i.code !== "analysis.heuristic-export-surface",
    );
    expect(kotlinIssues).toHaveLength(0);
  });

  it("passes clean Vue file with correct MODULE_MAP", () => {
    const root = createProject();
    writeDocs(root);

    writeFile(
      root,
      "src/MyWidget.vue",
      `<!-- START_MODULE_CONTRACT
  PURPOSE: Vue widget.
  SCOPE: Expose widget setup.
  DEPENDS: none
  LINKS: M-EXAMPLE
END_MODULE_CONTRACT

START_MODULE_MAP
  setup - Component setup function.
END_MODULE_MAP

START_CHANGE_SUMMARY
  LAST_CHANGE: [v0.1.0]
END_CHANGE_SUMMARY -->
<template><div>hi</div></template>
<script lang="ts">
export function setup() { return {}; }
</script>
`,
    );

    const result = lintGraceProject(root);
    const vueIssues = result.issues.filter(
      (i) => i.file === "src/MyWidget.vue" && i.code !== "analysis.heuristic-export-surface",
    );
    expect(vueIssues).toHaveLength(0);
  });

  // FIX-1: Dart triple-quoted string with unbalanced braces must not confuse depth tracking
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
    const analysis = createDartAdapter().analyze("lib/fix1.dart", text);
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
    const analysis = createDartAdapter().analyze("lib/fix1b.dart", text);
    expect(analysis.exports.has("First")).toBe(true);
    expect(analysis.exports.has("Second")).toBe(true);
  });

  // exportsComplete=true (Python without __all__): extra-export fires as warning
  it("Python WITHOUT __all__: MODULE_MAP symbol absent from file emits markup.module-map-extra-export (warning)", () => {
    const root = createProject();
    writeDocs(root);

    writeFile(
      root,
      "src/greeter.py",
      `# START_MODULE_CONTRACT
#   PURPOSE: Python greeter.
#   SCOPE: Expose greeting function.
#   DEPENDS: none
#   LINKS: M-EXAMPLE
# END_MODULE_CONTRACT
#
# START_MODULE_MAP
#   foo - Real function.
#   missing_fn - Does not exist in source (typo or deleted).
# END_MODULE_MAP
#
# START_CHANGE_SUMMARY
#   LAST_CHANGE: [v0.1.0]
# END_CHANGE_SUMMARY

def foo():
    return "hi"
`,
    );

    const result = lintGraceProject(root);
    const pyIssues = result.issues.filter((i) => i.file === "src/greeter.py");
    const codes = pyIssues.map((i) => i.code);
    // Python adapter: exportsComplete=true, exportConfidence="heuristic" → exportSeverity="warning"
    expect(codes).toContain("markup.module-map-extra-export");
    const extraIssue = pyIssues.find((i) => i.code === "markup.module-map-extra-export");
    expect(extraIssue?.severity).toBe("warning");
    // Should NOT contain missing-export (foo IS in MODULE_MAP)
    expect(codes).not.toContain("markup.module-map-missing-export");
  });

  it("Python WITHOUT __all__: correct MODULE_MAP produces no extra-export", () => {
    const root = createProject();
    writeDocs(root);

    writeFile(
      root,
      "src/greeter2.py",
      `# START_MODULE_CONTRACT
#   PURPOSE: Python greeter.
#   SCOPE: Expose greeting function.
#   DEPENDS: none
#   LINKS: M-EXAMPLE
# END_MODULE_CONTRACT
#
# START_MODULE_MAP
#   foo - Real function.
# END_MODULE_MAP
#
# START_CHANGE_SUMMARY
#   LAST_CHANGE: [v0.1.0]
# END_CHANGE_SUMMARY

def foo():
    return "hi"
`,
    );

    const result = lintGraceProject(root);
    const pyIssues = result.issues.filter((i) => i.file === "src/greeter2.py");
    const codes = pyIssues.map((i) => i.code);
    // heuristic confidence → heuristic advisory fires, but no extra-export or missing-export
    expect(codes).toContain("analysis.heuristic-export-surface");
    expect(codes).not.toContain("markup.module-map-extra-export");
    expect(codes).not.toContain("markup.module-map-missing-export");
  });

  it("Dart (exportsComplete=false): MODULE_MAP symbol absent from file still produces NO extra-export", () => {
    // This is the existing Dart suppression test; kept/confirmed to ensure no regression.
    const root = createProject();
    writeDocs(root);

    writeFile(
      root,
      "src/dart_extra.dart",
      `// START_MODULE_CONTRACT
//   PURPOSE: Dart module.
//   SCOPE: Expose greeting function.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   greet - Real function.
//   doesNotExist - This symbol is completely absent.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0]
// END_CHANGE_SUMMARY

String greet(String name) => 'hi \$name';
`,
    );

    const result = lintGraceProject(root);
    const dartIssues = result.issues.filter((i) => i.file === "src/dart_extra.dart");
    const codes = dartIssues.map((i) => i.code);
    expect(codes).not.toContain("markup.module-map-extra-export");
    expect(codes).toContain("analysis.heuristic-export-surface");
  });

  it("Kotlin (exportsComplete=false): MODULE_MAP symbol absent from file still produces NO extra-export", () => {
    const root = createProject();
    writeDocs(root);

    writeFile(
      root,
      "src/KotlinExtra.kt",
      `// START_MODULE_CONTRACT
//   PURPOSE: Kotlin module.
//   SCOPE: Expose greeting function.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   greet - Real function.
//   doesNotExist - This symbol is completely absent.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0]
// END_CHANGE_SUMMARY

fun greet(name: String): String = "hi \$name"
`,
    );

    const result = lintGraceProject(root);
    const ktIssues = result.issues.filter((i) => i.file === "src/KotlinExtra.kt");
    const codes = ktIssues.map((i) => i.code);
    expect(codes).not.toContain("markup.module-map-extra-export");
    expect(codes).toContain("analysis.heuristic-export-surface");
  });

  // BUG-5: heuristic file with a MODULE_MAP miss must NOT produce double warning noise
  it("BUG-5: heuristic file emits at most one advisory signal, not both heuristic + missing-export", () => {
    const root = createProject();
    writeDocs(root);

    writeFile(
      root,
      "src/Counter.kt",
      `// START_MODULE_CONTRACT
//   PURPOSE: Kotlin counter.
//   SCOPE: Expose counter.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Counter - Main counter class.
//   missingFn - Does not exist in source.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0]
// END_CHANGE_SUMMARY

class Counter
`,
    );

    const result = lintGraceProject(root);
    const fileIssues = result.issues.filter((i) => i.file === "src/Counter.kt");
    const heuristicWarnings = fileIssues.filter((i) => i.code === "analysis.heuristic-export-surface");
    const missingExportWarnings = fileIssues.filter((i) => i.code === "markup.module-map-missing-export");

    // missing-export is suppressed when confidence=heuristic (unchanged guard).
    expect(missingExportWarnings).toHaveLength(0);
    // extra-export is suppressed for Kotlin because exportsComplete=false (regex can miss decls).
    // The exportsComplete guard is independent of exportConfidence.
    const extraExportWarnings = fileIssues.filter((i) => i.code === "markup.module-map-extra-export");
    expect(extraExportWarnings).toHaveLength(0);
    // Overall: heuristic advisory is present
    expect(heuristicWarnings.length).toBeGreaterThan(0);
  });
});
