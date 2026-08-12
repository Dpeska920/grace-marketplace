import { describe, expect, it } from "bun:test";

import { createKotlinAdapter } from "./kotlin";

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

  it("populates localSymbols to mirror the heuristic public-surface export set", () => {
    const text = `class Repo\nprivate class Hidden`;
    const analysis = adapter.analyze("src/Repo.kt", text);
    expect(analysis.localSymbols.has("Repo")).toBe(true);
    expect(analysis.localSymbols.has("Hidden")).toBe(false);
  });
});
