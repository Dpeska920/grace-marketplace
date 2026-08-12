// START_MODULE_CONTRACT
//   PURPOSE: Regression tests for the three autonomy-linter false-positive fixes.
//   SCOPE: lineHasRuntimeMarker statement coalescing, Dart emit primitives, Bug3 directory directionality.
//   DEPENDS: bun:test
//   ROLE: TEST
//   MAP_MODE: SUMMARY
//   LINKS: M-LINT-ADAPTERS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SUMMARY: Unit tests for lintAutonomousReadiness helper functions extracted via the integration test harness.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2 - Add regression coverage for Bug 1/2/3 + FIX-10 string-paren false-positive]
// END_CHANGE_SUMMARY

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { lintGraceProject } from "../grace-lint";

// Build block-anchor strings at runtime so the source file itself does not
// contain the literal token START_BLOCK_<NAME>, which would cause grace's
// own self-lint to mis-count these fixture strings as real semantic blocks.
const BLOCK = (name: string) => `// ${"START"}_${"BLOCK"}_${name}`;
const ENDBLOCK = (name: string) => `// ${"END"}_${"BLOCK"}_${name}`;

// ---------------------------------------------------------------------------
// Helpers: minimal GRACE project scaffold
// ---------------------------------------------------------------------------

function createProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grace-marker-fix-"));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  return root;
}

function writeFile(root: string, rel: string, content: string) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Write the minimal technology.xml, development-plan.xml, knowledge-graph.xml. */
function writeBaseDocs(root: string, moduleId = "M-EXAMPLE", sourcePath = "lib/example.dart") {
  writeFile(
    root,
    "docs/technology.xml",
    `<TechnologyStack VERSION="0.2.0">
  <Runtime>dart 3.x</Runtime>
  <Language>dart</Language>
  <PreferredAgentStack>
    <preferred-runtime-library>flutter</preferred-runtime-library>
    <preferred-test-library>flutter_test</preferred-test-library>
  </PreferredAgentStack>
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
    <${moduleId} NAME="Example" TYPE="CORE_LOGIC">
      <purpose>Example module.</purpose>
      <path>${sourcePath}</path>
      <depends>none</depends>
      <verification-ref>V-${moduleId.slice(2)}</verification-ref>
      <annotations>
        <fn-run PURPOSE="Run example" />
      </annotations>
    </${moduleId}>
  </Project>
</KnowledgeGraph>`,
  );

  writeFile(
    root,
    "docs/development-plan.xml",
    `<DevelopmentPlan VERSION="0.1.0">
  <Modules>
    <${moduleId} NAME="Example" TYPE="CORE_LOGIC" STATUS="implemented">
      <contract><purpose>Example module.</purpose></contract>
      <verification-ref>V-${moduleId.slice(2)}</verification-ref>
    </${moduleId}>
  </Modules>
  <ImplementationOrder>
    <Phase-1 name="Foundation" status="done">
      <step-1 module="${moduleId}" status="done" verification="V-${moduleId.slice(2)}">Implement example.</step-1>
    </Phase-1>
  </ImplementationOrder>
</DevelopmentPlan>`,
  );

  writeFile(
    root,
    "docs/operational-packets.xml",
    `<OperationalPackets VERSION="0.1.0">
  <ExecutionPacketTemplate>
    <ExecutionPacket>
      <assumptions />
      <stop-conditions />
      <retry-budget>2</retry-budget>
      <checkpoint-fields />
    </ExecutionPacket>
  </ExecutionPacketTemplate>
  <CheckpointReportTemplate><CheckpointReport /></CheckpointReportTemplate>
  <GraphDeltaTemplate><GraphDelta /></GraphDeltaTemplate>
  <VerificationDeltaTemplate><VerificationDelta /></VerificationDeltaTemplate>
  <FailurePacketTemplate><FailurePacket /></FailurePacketTemplate>
</OperationalPackets>`,
  );
}

const CONTRACT_HEADER = `// START_MODULE_CONTRACT
//   PURPOSE: Example module.
//   SCOPE: Core logic.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   run - Execute the example flow.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1 - initial]
// END_CHANGE_SUMMARY
`;

// ---------------------------------------------------------------------------
// Bug 1+2: Dart single-line emit (debugPrint) — invariant (a)
// ---------------------------------------------------------------------------
describe("Bug1+2 — Dart emit primitives", () => {
  it("(a) single-line debugPrint with marker → MATCH (no false-positive)", () => {
    const root = createProject();
    const marker = "[ExampleDomain][run][BLOCK_EXECUTE_FLOW]";
    writeBaseDocs(root);

    writeFile(
      root,
      "lib/example.dart",
      `${CONTRACT_HEADER}
void run() {
  ${BLOCK("EXECUTE_FLOW")}
  debugPrint('${marker}');
  ${ENDBLOCK("EXECUTE_FLOW")}
}
`,
    );

    writeFile(root, "test/example_test.dart", `void main() {}`);

    writeFile(
      root,
      "docs/verification-plan.xml",
      `<VerificationPlan VERSION="0.1.0">
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files><file-1>test/example_test.dart</file-1></test-files>
      <module-checks><command-1>flutter test test/example_test.dart</command-1></module-checks>
      <scenarios><scenario-1 kind="success">Happy path.</scenario-1></scenarios>
      <required-log-markers><marker-1>${marker}</marker-1></required-log-markers>
      <wave-follow-up>run merged integration path</wave-follow-up>
      <phase-follow-up>run full regression suite</phase-follow-up>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain("autonomy.required-log-marker-not-found");
  });

  // ---------------------------------------------------------------------------
  // Bug 2: Multi-line dartfmt-wrapped emit — invariant (b)
  // ---------------------------------------------------------------------------
  it("(b) multi-line dartfmt-wrapped debugPrint with marker → MATCH", () => {
    const root = createProject();
    const marker = "[ExampleDomain][run][BLOCK_EXECUTE_FLOW]";
    writeBaseDocs(root);

    writeFile(
      root,
      "lib/example.dart",
      `${CONTRACT_HEADER}
void run() {
  ${BLOCK("EXECUTE_FLOW")}
  debugPrint(
    '${marker}',
  );
  ${ENDBLOCK("EXECUTE_FLOW")}
}
`,
    );

    writeFile(root, "test/example_test.dart", `void main() {}`);

    writeFile(
      root,
      "docs/verification-plan.xml",
      `<VerificationPlan VERSION="0.1.0">
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files><file-1>test/example_test.dart</file-1></test-files>
      <module-checks><command-1>flutter test test/example_test.dart</command-1></module-checks>
      <scenarios><scenario-1 kind="success">Happy path.</scenario-1></scenarios>
      <required-log-markers><marker-1>${marker}</marker-1></required-log-markers>
      <wave-follow-up>run merged integration path</wave-follow-up>
      <phase-follow-up>run full regression suite</phase-follow-up>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain("autonomy.required-log-marker-not-found");
  });

  // ---------------------------------------------------------------------------
  // Invariant (c): existing TypeScript Logger.info single-line → still MATCH (regression)
  // ---------------------------------------------------------------------------
  it("(c) existing Logger.info single-line emit → still MATCH (regression guard)", () => {
    const root = createProject();
    const marker = "[ExampleDomain][run][BLOCK_EXECUTE_FLOW]";
    writeBaseDocs(root, "M-EXAMPLE", "src/example.ts");

    writeFile(
      root,
      "src/example.ts",
      `${CONTRACT_HEADER}
export function run() {
  ${BLOCK("EXECUTE_FLOW")}
  logger.info('ctx', '${marker}');
  ${ENDBLOCK("EXECUTE_FLOW")}
}
`,
    );

    writeFile(root, "src/example.test.ts", `export const x = 1;`);

    writeFile(
      root,
      "docs/verification-plan.xml",
      `<VerificationPlan VERSION="0.1.0">
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files><file-1>src/example.test.ts</file-1></test-files>
      <module-checks><command-1>bun test src/example.test.ts</command-1></module-checks>
      <scenarios><scenario-1 kind="success">Happy path.</scenario-1></scenarios>
      <required-log-markers><marker-1>${marker}</marker-1></required-log-markers>
      <wave-follow-up>run merged integration path</wave-follow-up>
      <phase-follow-up>run full regression suite</phase-follow-up>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain("autonomy.required-log-marker-not-found");
  });

  // ---------------------------------------------------------------------------
  // Invariant (d): comment-only line with marker, no emit call → NO match
  // ---------------------------------------------------------------------------
  it("(d) comment-only line with marker and no emit call → must NOT match", () => {
    const root = createProject();
    const marker = "[ExampleDomain][run][BLOCK_EXECUTE_FLOW]";
    writeBaseDocs(root);

    writeFile(
      root,
      "lib/example.dart",
      `${CONTRACT_HEADER}
void run() {
  ${BLOCK("EXECUTE_FLOW")}
  // ${marker}   ← this is only a comment, no actual emit
  final x = 1;
  ${ENDBLOCK("EXECUTE_FLOW")}
}
`,
    );

    writeFile(root, "test/example_test.dart", `void main() {}`);

    writeFile(
      root,
      "docs/verification-plan.xml",
      `<VerificationPlan VERSION="0.1.0">
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files><file-1>test/example_test.dart</file-1></test-files>
      <module-checks><command-1>flutter test test/example_test.dart</command-1></module-checks>
      <scenarios><scenario-1 kind="success">Happy path.</scenario-1></scenarios>
      <required-log-markers><marker-1>${marker}</marker-1></required-log-markers>
      <wave-follow-up>run merged integration path</wave-follow-up>
      <phase-follow-up>run full regression suite</phase-follow-up>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    // The marker is in a comment — must still be reported as NOT found.
    expect(codes).toContain("autonomy.required-log-marker-not-found");
  });

  // ---------------------------------------------------------------------------
  // Invariant (e): marker in plain assignment (no emit primitive) → NO match
  // ---------------------------------------------------------------------------
  it("(e) marker in plain string assignment with no emit primitive → must NOT match", () => {
    const root = createProject();
    const marker = "[ExampleDomain][run][BLOCK_EXECUTE_FLOW]";
    writeBaseDocs(root);

    writeFile(
      root,
      "lib/example.dart",
      `${CONTRACT_HEADER}
void run() {
  ${BLOCK("EXECUTE_FLOW")}
  final label = '${marker}';
  ${ENDBLOCK("EXECUTE_FLOW")}
}
`,
    );

    writeFile(root, "test/example_test.dart", `void main() {}`);

    writeFile(
      root,
      "docs/verification-plan.xml",
      `<VerificationPlan VERSION="0.1.0">
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files><file-1>test/example_test.dart</file-1></test-files>
      <module-checks><command-1>flutter test test/example_test.dart</command-1></module-checks>
      <scenarios><scenario-1 kind="success">Happy path.</scenario-1></scenarios>
      <required-log-markers><marker-1>${marker}</marker-1></required-log-markers>
      <wave-follow-up>run merged integration path</wave-follow-up>
      <phase-follow-up>run full regression suite</phase-follow-up>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    // Marker is in a plain assignment — must still be reported as NOT found.
    expect(codes).toContain("autonomy.required-log-marker-not-found");
  });
});

// ---------------------------------------------------------------------------
// Bug 3: directory-scoped module-check covers test file (non-inverted check)
// ---------------------------------------------------------------------------
describe("Bug3 — module-check directionality", () => {
  it("directory-scoped flutter test command covers a nested test file → no false-positive warning", () => {
    const root = createProject();
    const marker = "[ExampleDomain][run][BLOCK_EXECUTE_FLOW]";
    writeBaseDocs(root, "M-EXAMPLE", "lib/example.dart");

    writeFile(
      root,
      "lib/example.dart",
      `${CONTRACT_HEADER}
void run() {
  ${BLOCK("EXECUTE_FLOW")}
  debugPrint('${marker}');
  ${ENDBLOCK("EXECUTE_FLOW")}
}
`,
    );

    // Test file is NESTED under the dir the command references.
    writeFile(root, "test/features/ui/bloc/example_test.dart", `void main() {}`);

    writeFile(
      root,
      "docs/verification-plan.xml",
      `<VerificationPlan VERSION="0.1.0">
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files>
        <file-1>test/features/ui/bloc/example_test.dart</file-1>
      </test-files>
      <module-checks>
        <!-- Directory-scoped: shorter than testFile path -->
        <command-1>flutter test test/features/ui/</command-1>
      </module-checks>
      <scenarios><scenario-1 kind="success">Happy path.</scenario-1></scenarios>
      <required-log-markers><marker-1>${marker}</marker-1></required-log-markers>
      <wave-follow-up>run merged integration path</wave-follow-up>
      <phase-follow-up>run full regression suite</phase-follow-up>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain("autonomy.verification-module-check-does-not-reference-test-file");
  });

  it("a check command with a completely unrelated path does NOT cover the test file", () => {
    const root = createProject();
    const marker = "[ExampleDomain][run][BLOCK_EXECUTE_FLOW]";
    writeBaseDocs(root, "M-EXAMPLE", "lib/example.dart");

    writeFile(
      root,
      "lib/example.dart",
      `${CONTRACT_HEADER}
void run() {
  ${BLOCK("EXECUTE_FLOW")}
  debugPrint('${marker}');
  ${ENDBLOCK("EXECUTE_FLOW")}
}
`,
    );

    writeFile(root, "test/features/ui/bloc/example_test.dart", `void main() {}`);

    writeFile(
      root,
      "docs/verification-plan.xml",
      `<VerificationPlan VERSION="0.1.0">
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files>
        <file-1>test/features/ui/bloc/example_test.dart</file-1>
      </test-files>
      <module-checks>
        <!-- Points to a completely different directory -->
        <command-1>flutter test test/other/module/</command-1>
      </module-checks>
      <scenarios><scenario-1 kind="success">Happy path.</scenario-1></scenarios>
      <required-log-markers><marker-1>${marker}</marker-1></required-log-markers>
      <wave-follow-up>run merged integration path</wave-follow-up>
      <phase-follow-up>run full regression suite</phase-follow-up>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    // Unrelated directory: should still warn.
    expect(codes).toContain("autonomy.verification-module-check-does-not-reference-test-file");
  });
});

// ---------------------------------------------------------------------------
// FIX-10: lineHasRuntimeMarker paren-balance must be string-blind
// ---------------------------------------------------------------------------
describe("FIX-10 — lineHasRuntimeMarker string-paren false-positive", () => {
  // A line with an unbalanced paren inside a string (e.g. debugPrint('hello (world');)
  // must NOT glue the next physical line into the same logical statement.
  // If it did, a plain assignment on the next line (`final label = '[X][run][BLOCK_F]';`)
  // would be concatenated with the emit call and the marker would be found —
  // producing a false positive.
  it("unbalanced paren in string arg does NOT cause next-line plain assignment to be glued as marker evidence", () => {
    const root = createProject();
    const marker = "[ExampleDomain][run][BLOCK_EXECUTE_FLOW]";
    writeBaseDocs(root);

    // Source: debugPrint('hello (world') has an unbalanced ( inside the string.
    // The next line is a plain assignment — the marker lives there but NOT in an emit.
    writeFile(
      root,
      "lib/example.dart",
      `${CONTRACT_HEADER}
void run() {
  ${BLOCK("EXECUTE_FLOW")}
  debugPrint('hello (world');
  final label = '${marker}';
  ${ENDBLOCK("EXECUTE_FLOW")}
}
`,
    );

    writeFile(root, "test/example_test.dart", `void main() {}`);

    writeFile(
      root,
      "docs/verification-plan.xml",
      `<VerificationPlan VERSION="0.1.0">
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files><file-1>test/example_test.dart</file-1></test-files>
      <module-checks><command-1>flutter test test/example_test.dart</command-1></module-checks>
      <scenarios><scenario-1 kind="success">Happy path.</scenario-1></scenarios>
      <required-log-markers><marker-1>${marker}</marker-1></required-log-markers>
      <wave-follow-up>run merged integration path</wave-follow-up>
      <phase-follow-up>run full regression suite</phase-follow-up>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    // The marker is in a plain assignment (not an emit call) and must NOT be accepted.
    expect(codes).toContain("autonomy.required-log-marker-not-found");
  });

  // A genuinely dartfmt-wrapped emit where the marker is on a continuation line
  // of a real debugPrint( call must still be detected TRUE.
  it("genuinely dartfmt-wrapped debugPrint( with marker on continuation line → MATCH", () => {
    const root = createProject();
    const marker = "[ExampleDomain][run][BLOCK_EXECUTE_FLOW]";
    writeBaseDocs(root);

    // debugPrint( is on one line; the marker string is on the next physical line.
    // The paren is real (not inside a string), so depth stays > 0 until ')'.
    writeFile(
      root,
      "lib/example.dart",
      `${CONTRACT_HEADER}
void run() {
  ${BLOCK("EXECUTE_FLOW")}
  debugPrint(
    '${marker}',
  );
  ${ENDBLOCK("EXECUTE_FLOW")}
}
`,
    );

    writeFile(root, "test/example_test.dart", `void main() {}`);

    writeFile(
      root,
      "docs/verification-plan.xml",
      `<VerificationPlan VERSION="0.1.0">
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files><file-1>test/example_test.dart</file-1></test-files>
      <module-checks><command-1>flutter test test/example_test.dart</command-1></module-checks>
      <scenarios><scenario-1 kind="success">Happy path.</scenario-1></scenarios>
      <required-log-markers><marker-1>${marker}</marker-1></required-log-markers>
      <wave-follow-up>run merged integration path</wave-follow-up>
      <phase-follow-up>run full regression suite</phase-follow-up>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    // A real dartfmt-wrapped emit — must be accepted as marker evidence.
    expect(codes).not.toContain("autonomy.required-log-marker-not-found");
  });
});

// ---------------------------------------------------------------------------
// PATCH A — generic Identifier.<level>( emission detection
// ---------------------------------------------------------------------------
// The patch added support for Flutter/Dart Log.w/e/d/i/v patterns so that
// `Log.d('[M][fn][BLOCK_X] ...')` is recognised as an evidence emission, just
// like debugPrint/logger.info/etc.
// ---------------------------------------------------------------------------

/**
 * Build a minimal verification-plan.xml snippet for a single marker.
 * Re-uses the same structure expected by writeBaseDocs(root, "M-EXAMPLE", ...).
 */
function makeVerificationPlan(root: string, marker: string, testFile: string) {
  writeFile(
    root,
    "docs/verification-plan.xml",
    `<VerificationPlan VERSION="0.1.0">
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files><file-1>${testFile}</file-1></test-files>
      <module-checks><command-1>flutter test ${testFile}</command-1></module-checks>
      <scenarios><scenario-1 kind="success">Happy path.</scenario-1></scenarios>
      <required-log-markers><marker-1>${marker}</marker-1></required-log-markers>
      <wave-follow-up>run integration path</wave-follow-up>
      <phase-follow-up>run full regression suite</phase-follow-up>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`,
  );
}

describe("PATCH A — Identifier.<level>( generic emission detection", () => {
  // A1a: Log.d (debug level) single-line — must be detected as emission.
  it("A1a: Log.d('marker') single-line → MATCH (no required-log-marker-not-found)", () => {
    const root = createProject();
    const marker = "[Shared][resetUroflowmeter][BLOCK_RESET_UROFLOWMETER]";
    writeBaseDocs(root, "M-EXAMPLE", "lib/example.dart");

    writeFile(
      root,
      "lib/example.dart",
      `${CONTRACT_HEADER}
void resetUroflowmeter() {
  ${BLOCK("RESET_UROFLOWMETER")}
  Log.d('${marker} starting reset');
  ${ENDBLOCK("RESET_UROFLOWMETER")}
}
`,
    );

    writeFile(root, "test/example_test.dart", `void main() {}`);
    makeVerificationPlan(root, marker, "test/example_test.dart");

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain("autonomy.required-log-marker-not-found");
  });

  // A1b: Log.w (warn level) — must also be detected.
  it("A1b: Log.w('marker') single-line → MATCH (warn level also recognised)", () => {
    const root = createProject();
    const marker = "[Shared][resetUroflowmeter][BLOCK_RESET_UROFLOWMETER]";
    writeBaseDocs(root, "M-EXAMPLE", "lib/example.dart");

    writeFile(
      root,
      "lib/example.dart",
      `${CONTRACT_HEADER}
void resetUroflowmeter() {
  ${BLOCK("RESET_UROFLOWMETER")}
  Log.w('${marker} unexpected state');
  ${ENDBLOCK("RESET_UROFLOWMETER")}
}
`,
    );

    writeFile(root, "test/example_test.dart", `void main() {}`);
    makeVerificationPlan(root, marker, "test/example_test.dart");

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain("autonomy.required-log-marker-not-found");
  });

  // A1c: Log.e (error level) — must also be detected.
  it("A1c: Log.e('marker') single-line → MATCH (error level also recognised)", () => {
    const root = createProject();
    const marker = "[Shared][resetUroflowmeter][BLOCK_RESET_UROFLOWMETER]";
    writeBaseDocs(root, "M-EXAMPLE", "lib/example.dart");

    writeFile(
      root,
      "lib/example.dart",
      `${CONTRACT_HEADER}
void resetUroflowmeter() {
  ${BLOCK("RESET_UROFLOWMETER")}
  Log.e('${marker} fatal error');
  ${ENDBLOCK("RESET_UROFLOWMETER")}
}
`,
    );

    writeFile(root, "test/example_test.dart", `void main() {}`);
    makeVerificationPlan(root, marker, "test/example_test.dart");

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain("autonomy.required-log-marker-not-found");
  });

  // A2a: marker is entirely absent from the file → must still fire.
  it("A2a: required marker absent from file → required-log-marker-not-found STILL fires", () => {
    const root = createProject();
    const marker = "[Shared][resetUroflowmeter][BLOCK_RESET_UROFLOWMETER]";
    writeBaseDocs(root, "M-EXAMPLE", "lib/example.dart");

    // File has no mention of the required marker at all.
    writeFile(
      root,
      "lib/example.dart",
      `${CONTRACT_HEADER}
void resetUroflowmeter() {
  ${BLOCK("RESET_UROFLOWMETER")}
  Log.d('starting reset');
  ${ENDBLOCK("RESET_UROFLOWMETER")}
}
`,
    );

    writeFile(root, "test/example_test.dart", `void main() {}`);
    makeVerificationPlan(root, marker, "test/example_test.dart");

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    // Marker is completely missing — must still report not-found.
    expect(codes).toContain("autonomy.required-log-marker-not-found");
  });

  // A2b: marker present only in a // comment with a Log.d call elsewhere → must still fire.
  it("A2b: marker inside a // comment only (no emit call with marker) → required-log-marker-not-found STILL fires", () => {
    const root = createProject();
    const marker = "[Shared][resetUroflowmeter][BLOCK_RESET_UROFLOWMETER]";
    writeBaseDocs(root, "M-EXAMPLE", "lib/example.dart");

    // The marker token appears only in a comment; there is a Log.d call but it
    // does NOT carry the marker.  The broadened regex must NOT accept this.
    writeFile(
      root,
      "lib/example.dart",
      `${CONTRACT_HEADER}
void resetUroflowmeter() {
  ${BLOCK("RESET_UROFLOWMETER")}
  // ${marker}  ← marker is in a comment, not an emission
  Log.d('starting reset');
  ${ENDBLOCK("RESET_UROFLOWMETER")}
}
`,
    );

    writeFile(root, "test/example_test.dart", `void main() {}`);
    makeVerificationPlan(root, marker, "test/example_test.dart");

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    // Marker only in comment — broadening must not over-suppress.
    expect(codes).toContain("autonomy.required-log-marker-not-found");
  });
});
