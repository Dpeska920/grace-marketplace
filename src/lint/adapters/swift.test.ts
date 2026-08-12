import { describe, expect, it } from "bun:test";

import { createSwiftAdapter } from "./swift";

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

  it("populates localSymbols to mirror the heuristic public-surface export set", () => {
    const text = `public class Visible {}\nclass Hidden {}`;
    const analysis = adapter.analyze("Sources/Mix.swift", text);
    expect(analysis.localSymbols.has("Visible")).toBe(true);
    expect(analysis.localSymbols.has("Hidden")).toBe(false);
  });
});
