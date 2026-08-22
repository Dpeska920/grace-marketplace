import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, test } from "bun:test";

import { analyzeGovernedFile, hasRuntimeMarkerEvidence, parseGovernedFile } from "./project-utils";

/**
 * Builds a governed-file fixture with independently controllable ROLE, MAP_MODE, and
 * MODULE_CONTRACT fields, plus an optional MODULE_MAP body and trailing source body.
 * Unlike the narrower `contract()` helper above (which derives ROLE from mapMode), this
 * lets tests set ROLE and MAP_MODE to diverging values on purpose.
 */
function buildFile(opts: {
  role?: string;
  mapMode?: string;
  purpose?: string;
  scope?: string;
  depends?: string;
  links?: string;
  moduleMap?: string;
  body?: string;
}): string {
  const roleLine = opts.role !== undefined ? `// ROLE: ${opts.role}\n` : "";
  const mapModeLine = opts.mapMode !== undefined ? `// MAP_MODE: ${opts.mapMode}\n` : "";
  const header = `// START_MODULE_CONTRACT
// PURPOSE: ${opts.purpose ?? "Exercise semantic markup."}
// SCOPE: ${opts.scope ?? "Test-only fixture."}
// DEPENDS: ${opts.depends ?? "none"}
// LINKS: ${opts.links ?? "M-EXAMPLE"}
${roleLine}${mapModeLine}// END_MODULE_CONTRACT
`;
  const map = opts.moduleMap !== undefined ? `// START_MODULE_MAP\n${opts.moduleMap}\n// END_MODULE_MAP\n` : "";
  return `${header}${map}${opts.body ?? ""}`;
}

function tmpTarget(prefix: string, name = "example.ts") {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, file: path.join(root, "src", name) };
}

function contract(mapMode: "EXPORTS" | "LOCALS" | "SUMMARY" | "NONE", moduleMap = ""): string {
  return `// START_MODULE_CONTRACT
// PURPOSE: Exercise semantic markup.
// SCOPE: Test-only fixture.
// DEPENDS: none
// LINKS: M-EXAMPLE
// ROLE: ${mapMode === "LOCALS" ? "SCRIPT" : mapMode === "SUMMARY" ? "BARREL" : mapMode === "NONE" ? "CONFIG" : "RUNTIME"}
// MAP_MODE: ${mapMode}
// END_MODULE_CONTRACT
${moduleMap ? `// START_MODULE_MAP\n${moduleMap}\n// END_MODULE_MAP\n` : ""}`;
}

describe("governed file analysis", () => {
  it("parses the shared markup record and enforces exact TypeScript value/type export parity", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-markup-"));
    const file = path.join(root, "src", "example.ts");
    const text = `${contract("EXPORTS", "// value - Runtime value.\n// ExampleType - Public type.")}export const value = 1;\nexport type ExampleType = string;\n`;

    const record = parseGovernedFile(root, file, text);
    const analysis = analyzeGovernedFile(root, file, text);

    expect(record.path).toBe("src/example.ts");
    expect(record.linkedModuleIds).toEqual(["M-EXAMPLE"]);
    expect(record.moduleMap.map((item) => item.symbolName)).toEqual(["value", "ExampleType"]);
    expect(analysis.language?.exportConfidence).toBe("exact");
    expect(analysis.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
  });

  it("accepts bracketed and unbracketed LINKS lists while filtering non-module anchors", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-links-"));
    const file = path.join(root, "src", "example.ts");
    const links = (value: string) => parseGovernedFile(root, file, contract("NONE").replace("LINKS: M-EXAMPLE", `LINKS: ${value}`)).linkedModuleIds;

    expect(links("[M-ONE]")).toEqual(["M-ONE"]);
    expect(links("[M-ONE, M-TWO, V-M-ONE]")).toEqual(["M-ONE", "M-TWO"]);
    expect(links("M-ONE, M-TWO, V-M-ONE")).toEqual(["M-ONE", "M-TWO"]);
    expect(links("[none]")).toEqual([]);
    expect(links("none")).toEqual([]);
  });

  it("reports line-addressed missing, reversed, duplicate, mismatched, and overlapping markers", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-markers-"));
    const file = path.join(root, "broken.ts");
    const text = `// END_BLOCK_REVERSED
// START_MODULE_CONTRACT
// START_MODULE_MAP
// END_MODULE_CONTRACT
// START_BLOCK_DUP
// END_BLOCK_DUP
// START_BLOCK_DUP
// END_BLOCK_OTHER
// START_CHANGE_SUMMARY
`;
    const issues = analyzeGovernedFile(root, file, text).issues;
    const codes = issues.map((issue) => issue.code);

    expect(codes).toContain("markup.reversed-marker");
    expect(codes).toContain("markup.overlapping-markers");
    expect(codes).toContain("markup.mismatched-marker");
    expect(codes).toContain("markup.duplicate-marker");
    expect(codes).toContain("markup.missing-end-marker");
    expect(issues.filter((issue) => issue.code.startsWith("markup.")).every((issue) => typeof issue.line === "number")).toBe(true);
  });

  it("parses properly nested semantic blocks without reporting overlap", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-nested-blocks-"));
    const file = path.join(root, "nested.ts");
    const text = `// START_BLOCK_OUTER
// START_BLOCK_INNER
export const value = true;
// END_BLOCK_INNER
// END_BLOCK_OUTER
`;

    expect(parseGovernedFile(root, file, text).blocks).toEqual([
      { name: "OUTER", startLine: 1, endLine: 5 },
      { name: "INNER", startLine: 2, endLine: 4 },
    ]);
    expect(analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code)).not.toContain("markup.overlapping-markers");
  });

  it("does not manufacture an outer block from crossed nesting", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-crossed-blocks-"));
    const file = path.join(root, "crossed.ts");
    const text = `// START_BLOCK_OUTER
// START_BLOCK_INNER
// END_BLOCK_OUTER
// END_BLOCK_INNER
`;

    expect(parseGovernedFile(root, file, text).blocks.map((block) => block.name)).toEqual(["INNER"]);
    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);
    expect(codes).toContain("markup.mismatched-marker");
    expect(codes).toContain("markup.missing-end-marker");
  });

  it("credits exact marker constants with identifier-aware boundaries", () => {
    const marker = "[Example][run][BLOCK_RUN]";
    expect(hasRuntimeMarkerEvidence(`console.info("${marker} ok");`, marker)).toBe(true);
    expect(hasRuntimeMarkerEvidence(`const marker$ = "${marker}";\nconsole.info(marker$ + " ok");`, marker)).toBe(true);
    expect(hasRuntimeMarkerEvidence(`static let marker = "${marker}"\nlog.info("\\(marker) ok")`, marker)).toBe(true);
    expect(hasRuntimeMarkerEvidence(`const marker$ = "${marker}";\nconsole.info(marker$Other + " ok");`, marker)).toBe(false);
    expect(hasRuntimeMarkerEvidence(`const marker$ = "${marker}";\nreturn marker$;`, marker)).toBe(false);
    expect(hasRuntimeMarkerEvidence(`// const marker$ = "${marker}";\nconsole.info(marker$ + " ok");`, marker)).toBe(false);
  });

  it("credits a marker split across a multi-line runtime call by bracket balance", () => {
    const marker = "[Config][resolveChains][BLOCK_DROP_EMPTY_PROVIDERS]";

    expect(hasRuntimeMarkerEvidence(`logger.info({ chainType, provider: name }, "${marker} dropped");`, marker)).toBe(true);

    expect(
      hasRuntimeMarkerEvidence(
        `logger.info(\n  { chainType, provider: name },\n  '${marker} dropped provider with empty credentials',\n);`,
        marker,
      ),
    ).toBe(true);

    expect(
      hasRuntimeMarkerEvidence(
        `// logger.info(\n//   { chainType, provider: name },\n//   '${marker} dropped provider with empty credentials',\n// );`,
        marker,
      ),
    ).toBe(false);

    expect(
      hasRuntimeMarkerEvidence(`const MARKER = '${marker}';\nlogger.info(\n  { chainType },\n  MARKER,\n);`, marker),
    ).toBe(true);
  });

  it("does not let a stray apostrophe in comment prose desync marker credit", () => {
    const marker = "[Db][migrate][BLOCK_APPLY_MIGRATIONS]";
    const proseComment = "// note: the driver's connection pool caches sessions across retries";

    expect(
      hasRuntimeMarkerEvidence(
        `${proseComment}\nlogger.info(\n  { migration: name },\n  '${marker} applied',\n);`,
        marker,
      ),
    ).toBe(true);

    expect(hasRuntimeMarkerEvidence(`${proseComment}\nlogger.info('${marker} applied');`, marker)).toBe(true);

    expect(
      hasRuntimeMarkerEvidence(
        `// it's worth noting: logger.info(\n//   '${marker} applied',\n// );`,
        marker,
      ),
    ).toBe(false);
  });

  it("credits a Log-facade call with a single-letter method name", () => {
    const marker = "[AiGateway][onRequest][BLOCK_SIGNED]";

    expect(hasRuntimeMarkerEvidence(`Log.d('${marker} signature attached');`, marker)).toBe(true);
    expect(hasRuntimeMarkerEvidence(`Log.w('${marker} calibration rejected');`, marker)).toBe(true);

    expect(hasRuntimeMarkerEvidence(`// Log.d('${marker} signature attached');`, marker)).toBe(false);

    expect(hasRuntimeMarkerEvidence(`foo.d('${marker} signature attached');`, marker)).toBe(false);

    expect(
      hasRuntimeMarkerEvidence(`const MARKER = '${marker}';\nLog.d(MARKER);`, marker),
    ).toBe(true);
  });

  it("credits Flutter's bare debugPrint, including its multi-line form", () => {
    const marker = "[Shared][ReportsCubit][BLOCK_PERIOD_RESOLVE]";

    expect(hasRuntimeMarkerEvidence(`debugPrint('${marker} periods=\${periods.length}');`, marker)).toBe(true);

    expect(
      hasRuntimeMarkerEvidence(
        `debugPrint(\n  '${marker} periods=\${periods.length}',\n);`,
        marker,
      ),
    ).toBe(true);

    expect(hasRuntimeMarkerEvidence(`// debugPrint('${marker} periods=\${periods.length}');`, marker)).toBe(false);
  });

  it("credits dart:developer's developer.log(...) as the specific conventional pair", () => {
    const marker = "[Shared][PadTestSessionController][BLOCK_PAD_TEST_SESSION]";

    expect(
      hasRuntimeMarkerEvidence(
        `developer.log(\n  '${marker} start id=\$id',\n  name: 'PadTestSessionController',\n);`,
        marker,
      ),
    ).toBe(true);

    expect(hasRuntimeMarkerEvidence(`developer.log('${marker} start');`, marker)).toBe(true);

    expect(hasRuntimeMarkerEvidence(`// developer.log('${marker} start');`, marker)).toBe(false);

    // Just outside the specific pair: a differently named receiver calling
    // .log(, or `developer` calling a different method, must not be credited
    // by a relaxed lowercase-receiver rule that was deliberately not added.
    expect(hasRuntimeMarkerEvidence(`dev.log('${marker} start');`, marker)).toBe(false);
    expect(hasRuntimeMarkerEvidence(`developer.record('${marker} start');`, marker)).toBe(false);
  });

  it("does not credit bare print(...) as evidence emission", () => {
    const marker = "[Shared][Scratch][BLOCK_DEBUG_DUMP]";
    expect(hasRuntimeMarkerEvidence(`print('${marker} value=\$value');`, marker)).toBe(false);
  });

  it("emits bounded-confidence diagnostics for heuristic Python analysis", () => {
    const hasPython = ["python3", "python"].some((binary) => {
      const result = spawnSync(binary, ["--version"], { stdio: "ignore" });
      return !result.error && result.status === 0;
    });
    if (!hasPython) {
      return;
    }
    const root = mkdtempSync(path.join(os.tmpdir(), "grace-python-markup-"));
    const file = path.join(root, "example.py");
    const text = `# START_MODULE_CONTRACT
# PURPOSE: Python fixture.
# SCOPE: Export one function.
# DEPENDS: none
# LINKS: M-EXAMPLE
# ROLE: RUNTIME
# MAP_MODE: EXPORTS
# END_MODULE_CONTRACT
# START_MODULE_MAP
# greet - Public greeting.
# END_MODULE_MAP
def greet():
    return "hello"
`;
    const analysis = analyzeGovernedFile(root, file, text);
    expect(analysis.language?.exportConfidence).toBe("heuristic");
    expect(analysis.issues.map((issue) => issue.code)).toContain("analysis.heuristic-confidence");
    expect(analysis.issues.map((issue) => issue.code)).not.toContain("markup.module-map-mismatch");
  });

  it("preserves Unicode identifiers in exact Python MODULE_MAP parity", () => {
    const hasPython = ["python3", "python"].some((binary) => {
      const result = spawnSync(binary, ["--version"], { stdio: "ignore" });
      return !result.error && result.status === 0;
    });
    if (!hasPython) return;

    const root = mkdtempSync(path.join(os.tmpdir(), "grace-python-unicode-map-"));
    const file = path.join(root, "example.py");
    const text = `# START_MODULE_CONTRACT
# PURPOSE: Unicode Python fixture.
# SCOPE: Export one Unicode function.
# DEPENDS: none
# LINKS: M-EXAMPLE
# ROLE: RUNTIME
# MAP_MODE: EXPORTS
# END_MODULE_CONTRACT
# START_MODULE_MAP
# привет - Public greeting.
# END_MODULE_MAP
__all__ = ["привет"]
def привет():
    return "hello"
`;
    const analysis = analyzeGovernedFile(root, file, text);
    expect(analysis.record.moduleMap[0]?.symbolName).toBe("привет");
    expect(analysis.language?.exportConfidence).toBe("exact");
    expect(analysis.issues.map((issue) => issue.code)).not.toContain("markup.module-map-mismatch");
  });

  test("missing required language runtimes surface an actionable dedicated diagnostic without crashing", () => {
    const script = `import { analyzeGovernedFile } from "./src/project-utils.ts";
const text = ${JSON.stringify(`${contract("EXPORTS", "# greet - Greeting.").replaceAll("//", "#")}def greet():\n    return "hi"\n`)};
const result = analyzeGovernedFile(process.cwd(), process.cwd() + "/example.py", text);
console.log(JSON.stringify(result.issues));`;
    const run = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, PATH: mkdtempSync(path.join(os.tmpdir(), "grace-empty-path-")) },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    const issues = JSON.parse(Buffer.from(run.stdout).toString("utf8")) as Array<{ code: string; message: string }>;
    expect(issues.map((issue) => issue.code)).toContain("analysis.runtime-missing");
    expect(issues.find((issue) => issue.code === "analysis.runtime-missing")?.message).toContain("Install Python");
  });

  test("present but failing language runtimes surface analysis.adapter-failed without fallback", () => {
    const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "grace-broken-python-"));
    const python = path.join(runtimeDir, "python3");
    writeFileSync(python, "#!/bin/sh\nexit 17\n");
    chmodSync(python, 0o755);
    const script = `import { analyzeGovernedFile } from "./src/project-utils.ts";
const text = ${JSON.stringify(`${contract("EXPORTS", "# greet - Greeting.").replaceAll("//", "#")}def greet():\n    return "hi"\n`)};
const result = analyzeGovernedFile(process.cwd(), process.cwd() + "/example.py", text);
console.log(JSON.stringify(result.issues));`;
    const run = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, PATH: runtimeDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    const issues = JSON.parse(Buffer.from(run.stdout).toString("utf8")) as Array<{ code: string }>;
    expect(issues.map((issue) => issue.code)).toContain("analysis.adapter-failed");
    expect(issues.map((issue) => issue.code)).not.toContain("analysis.runtime-missing");
  });
});

// C-GRACE-MARKUP-DIAGNOSTIC-COVERAGE: positive coverage for four diagnostics that
// previously had zero fires-correctly assertions (only two not.toContain negatives
// existed for markup.module-map-mismatch, none for the other three). Written red,
// before any parser fix. `it.failing` cases assert the CORRECT behavior and are
// expected to fail against today's parser; removing `.failing` is part of the fix,
// not a passing criterion of this test file.
describe("markup.summary-item-undescribed", () => {
  it("fires when a SUMMARY item has no description on its own physical line", () => {
    const { root, file } = tmpTarget("grace-summary-missing-");
    const text = buildFile({ role: "BARREL", mapMode: "SUMMARY", moduleMap: "// widgetExport" });

    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);

    expect(codes).toContain("markup.summary-item-undescribed");
  });

  it("stays silent when a SUMMARY item carries a dash-delimited description", () => {
    const { root, file } = tmpTarget("grace-summary-present-");
    const text = buildFile({
      role: "BARREL",
      mapMode: "SUMMARY",
      moduleMap: "// widgetExport - re-exports the widget factory.",
    });

    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);

    expect(codes).not.toContain("markup.summary-item-undescribed");
  });

  it("stays silent for that exact same prose joined onto one physical line (control for the split case below)", () => {
    const { root, file } = tmpTarget("grace-summary-joined-");
    const text = buildFile({
      role: "BARREL",
      mapMode: "SUMMARY",
      moduleMap: "// widgetExport - re-exports the widget factory for downstream consumers.",
    });

    const codes = analyzeGovernedFile(root, file, text).issues.filter((issue) => issue.code === "markup.summary-item-undescribed");

    expect(codes).toHaveLength(0);
  });

  it("should stay silent (not double-report) when a SUMMARY item's description wraps onto the next physical line", () => {
    const { root, file } = tmpTarget("grace-summary-wrapped-");
    // Same content and same wording as the joined control above, split across two
    // physical lines. parseListSection treats every non-empty physical line as its
    // own list item, so today this reports TWO markup.summary-item-undescribed
    // issues: one for "widgetExport" (no "-"/":" on its own line) and a second
    // phantom one for the continuation line (no "-"/":" in it either). The content
    // did not change, only the line wrapping did; a fixed parser must treat this as
    // one logical item and stay silent, exactly like the joined control above.
    const text = buildFile({
      role: "BARREL",
      mapMode: "SUMMARY",
      moduleMap: "// widgetExport\n//   re-exports the widget factory for downstream consumers.",
    });

    const codes = analyzeGovernedFile(root, file, text).issues.filter((issue) => issue.code === "markup.summary-item-undescribed");

    expect(codes).toHaveLength(0);
  });
});

describe("markup.module-map-mismatch", () => {
  it("fires when the MODULE_MAP names a symbol the file does not export", () => {
    const { root, file } = tmpTarget("grace-map-wrong-");
    const text = `${buildFile({ mapMode: "EXPORTS", moduleMap: "// wrongName - Wrong description." })}export const value = 1;\n`;

    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);

    expect(codes).toContain("markup.module-map-mismatch");
  });

  it("stays silent when the MODULE_MAP names exactly the exported symbol", () => {
    const { root, file } = tmpTarget("grace-map-correct-");
    const text = `${buildFile({ mapMode: "EXPORTS", moduleMap: "// value - Correct description." })}export const value = 1;\n`;

    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);

    expect(codes).not.toContain("markup.module-map-mismatch");
  });

  it("should stay silent when a wrapped description's continuation line starts with an ordinary word, not a real export", () => {
    const { root, file } = tmpTarget("grace-map-phantom-extra-");
    // The file exports only `value`, documented by a single MODULE_MAP entry whose
    // description wraps onto a second physical line. parseListSection reads that
    // continuation as its own list item and extracts "further" as a symbolName
    // (it is a valid identifier shape), even though "further" is ordinary prose,
    // not a symbol. That phantom entry lands in `listed` as an undeclared extra,
    // so today this wrongly reports module-map-mismatch for content that correctly
    // documents its one real export.
    const moduleMap = "// value - Provides the shared runtime\n//   further explains how it is derived from configuration.";
    const text = `${buildFile({ mapMode: "EXPORTS", moduleMap })}export const value = 1;\n`;

    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);

    expect(codes).not.toContain("markup.module-map-mismatch");
  });

  it("should still catch an undocumented export when a wrapped continuation line happens to start with that export's real name", () => {
    const { root, file } = tmpTarget("grace-map-phantom-match-");
    // The file exports `value` and `helper`. Only `value` is genuinely documented;
    // its description wraps onto a second physical line that happens to start with
    // the word "helper" as ordinary prose, not as a second MODULE_MAP entry. Today
    // parseListSection reads that continuation as its own item and extracts
    // "helper" as a symbolName, which accidentally satisfies the real `helper`
    // export and hides the fact that it was never actually documented. A fixed
    // parser that folds the continuation back into value's description must catch
    // this as a real, still-undocumented export.
    const moduleMap = "// value - Provides the shared runtime\n//   helper for downstream consumers to call directly.";
    const text = `${buildFile({ mapMode: "EXPORTS", moduleMap })}export const value = 1;\nexport const helper = () => {};\n`;

    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);

    expect(codes).toContain("markup.module-map-mismatch");
  });

  // BL-114: LIST_SYMBOL_HEAD's lookahead rejected an identifier immediately
  // followed by `(`, so a "name(args) - desc" MODULE_MAP entry was recognized as an
  // item head (LIST_ITEM_HEAD accepts `\s*\(`) but yielded symbolName = undefined
  // and was dropped from parity checking, reporting the real export as missing.
  it("BL-114: 'name(args)' MODULE_MAP entry extracts symbolName and stays silent when the export exists", () => {
    const { root, file } = tmpTarget("grace-map-name-args-");
    const moduleMap = "// resolveAndroidVoiceAudioFormat(sdkInt) - VoiceAudioFormat; >= floor -> oggOpus, below -> aacLc.";
    const text = `${buildFile({ mapMode: "EXPORTS", moduleMap })}export function resolveAndroidVoiceAudioFormat(sdkInt: number) { return sdkInt; }\n`;

    expect(parseGovernedFile(root, file, text).moduleMap[0]?.symbolName).toBe("resolveAndroidVoiceAudioFormat");
    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);

    expect(codes).not.toContain("markup.module-map-mismatch");
  });

  // BL-114 guard: a wrapped description continuation that merely STARTS with
  // "name(...)" as prose must not become a phantom item whose symbolName
  // ("jsonEncode") is reported as an undeclared extra — only a head with a
  // description delimiter or end-of-line after the parens counts as an item.
  it("BL-114: wrapped prose continuation starting with 'name(...)' extracts no phantom symbolName", () => {
    const { root, file } = tmpTarget("grace-map-name-args-prose-");
    const moduleMap = "// DriftSource - row storage\n//   _insertMessage stores jsonEncode(...) when non-empty, NULL when empty";
    const text = `${buildFile({ mapMode: "EXPORTS", moduleMap })}export class DriftSource {}\n`;

    const record = parseGovernedFile(root, file, text);
    expect(record.moduleMap.map((item) => item.symbolName)).toEqual(["DriftSource"]);
    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);

    expect(codes).not.toContain("markup.module-map-mismatch");
  });
});

describe("markup.role-map-mode-mismatch", () => {
  it("stays silent when the explicit MAP_MODE already matches the ROLE's recommended default", () => {
    const { root, file } = tmpTarget("grace-role-default-");
    const text = buildFile({ role: "TEST", mapMode: "LOCALS", moduleMap: "// helper - Local helper." });

    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);

    expect(codes).not.toContain("markup.role-map-mode-mismatch");
  });

  it("stays silent when MAP_MODE is left implicit and only ROLE selects the default (no explicit values to compare)", () => {
    const { root, file } = tmpTarget("grace-role-implicit-mode-");
    const text = buildFile({ role: "TEST", moduleMap: "// helper - Local helper." });

    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);

    expect(codes).not.toContain("markup.role-map-mode-mismatch");
  });

  // NOTE: semantic-markup.md:37-45 calls the ROLE/MAP_MODE pairing "recommended
  // defaults", not a required pairing. The contract this suite locks in (per the
  // Plan pack) is: an explicit MAP_MODE always overrides the ROLE-implied default.
  // Given that, there is no remaining legitimate input for which
  // markup.role-map-mode-mismatch should fire post-fix — every case where role and
  // mapMode are both explicit and diverge is exactly the override the docs
  // recommend allowing. This is a finding, not an omission: the diagnostic's
  // "fires correctly" case does not exist under the corrected contract, only its
  // "stays silent" cases do (both above) plus the boundary below.
  it("should stay silent when an explicit MAP_MODE overrides the ROLE-implied default (ROLE: TEST, MAP_MODE: EXPORTS)", () => {
    const { root, file } = tmpTarget("grace-role-override-");
    const text = buildFile({ role: "TEST", mapMode: "EXPORTS", moduleMap: "// helper - Local helper." });

    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);

    expect(codes).not.toContain("markup.role-map-mode-mismatch");
  });
});

describe("markup.missing-contract-field", () => {
  it("fires for each MODULE_CONTRACT field left empty", () => {
    const { root, file } = tmpTarget("grace-contract-empty-");
    const text = buildFile({ purpose: "" });

    const issues = analyzeGovernedFile(root, file, text).issues.filter((issue) => issue.code === "markup.missing-contract-field");

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("PURPOSE");
  });

  // Was "...all four required fields..." (PURPOSE, SCOPE, DEPENDS, LINKS).
  // DEPENDS dropped out of the required set: grep -rn "fields.DEPENDS" src/
  // finds no reader anywhere else in the codebase, and on a real project it
  // was present in 100% of files but wrong in 38.4% of them — a required
  // field nothing reads and nothing checks for accuracy just trains authors
  // to fill in a placeholder. See project-utils.ts's analyzeGovernedFile
  // comment on the required-field list for the measurement.
  it("stays silent when all three required fields are non-empty", () => {
    const { root, file } = tmpTarget("grace-contract-filled-");
    const text = buildFile({});

    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);

    expect(codes).not.toContain("markup.missing-contract-field");
  });

  it("does not require DEPENDS: an empty DEPENDS field is not reported as missing", () => {
    const { root, file } = tmpTarget("grace-contract-no-depends-");
    const text = buildFile({ depends: "" });

    const issues = analyzeGovernedFile(root, file, text).issues.filter((issue) => issue.code === "markup.missing-contract-field");

    expect(issues).toHaveLength(0);
  });

  it("treats an explicit 'none' value as present, not missing, even though it resolves to zero linked modules", () => {
    const { root, file } = tmpTarget("grace-contract-none-");
    const text = buildFile({ links: "none" });

    const codes = analyzeGovernedFile(root, file, text).issues.map((issue) => issue.code);

    expect(codes).not.toContain("markup.missing-contract-field");
    expect(parseGovernedFile(root, file, text).linkedModuleIds).toEqual([]);
  });
});

describe("markup line reporting", () => {
  it("reports a MODULE_MAP item's real physical line, not the START_MODULE_MAP marker line one above it", () => {
    const { root, file } = tmpTarget("grace-line-number-");
    const itemLine = "// widgetExport - re-exports the widget factory.";
    const lines = [
      "// START_MODULE_CONTRACT",
      "// PURPOSE: Exercise semantic markup.",
      "// SCOPE: Test-only fixture.",
      "// DEPENDS: none",
      "// LINKS: M-EXAMPLE",
      "// ROLE: BARREL",
      "// MAP_MODE: SUMMARY",
      "// END_MODULE_CONTRACT",
      "// START_MODULE_MAP",
      itemLine,
      "// END_MODULE_MAP",
    ];
    const text = lines.join("\n");
    const realLineOfItem = lines.indexOf(itemLine) + 1; // 1-based physical line number

    const record = parseGovernedFile(root, file, text);

    expect(record.moduleMap[0]?.line).toBe(realLineOfItem);
  });
});
