import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { lintGraceProject } from "./grace-lint";
import { formatLintExplanation, getLintIssueGuide } from "./lint/catalog";

function createProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grace-lint-"));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  return root;
}

function writeProjectFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function writeBaseDocsWithoutVerification(root: string) {
  writeProjectFile(
    root,
    "docs/knowledge-graph.xml",
    `<KnowledgeGraph>
  <Project NAME="Example" VERSION="0.1.0">
    <M-EXAMPLE NAME="Example" TYPE="CORE_LOGIC">
      <purpose>Run the example flow.</purpose>
      <path>src/example.ts</path>
      <depends>none</depends>
    </M-EXAMPLE>
  </Project>
</KnowledgeGraph>`,
  );

  writeProjectFile(
    root,
    "docs/development-plan.xml",
    `<DevelopmentPlan VERSION="0.1.0">
  <Modules>
    <M-EXAMPLE NAME="Example" TYPE="CORE_LOGIC" STATUS="planned">
      <contract>
        <purpose>Run the example flow.</purpose>
      </contract>
    </M-EXAMPLE>
  </Modules>
</DevelopmentPlan>`,
  );
}

function writeCurrentDocs(root: string) {
  writeProjectFile(
    root,
    "docs/technology.xml",
    `<TechnologyStack VERSION="0.2.0">
  <Runtime>bun 1.3.8</Runtime>
  <Language>typescript 6.x</Language>
  <PreferredAgentStack>
    <preferred-runtime-library>bun</preferred-runtime-library>
    <preferred-test-library>bun:test</preferred-test-library>
  </PreferredAgentStack>
  <AutonomyPolicy>
    <default-execution-profile>balanced</default-execution-profile>
    <max-fix-attempts-per-step>2</max-fix-attempts-per-step>
  </AutonomyPolicy>
</TechnologyStack>`,
  );

  writeProjectFile(
    root,
    "docs/knowledge-graph.xml",
    `<KnowledgeGraph>
  <Project NAME="Example" VERSION="0.1.0">
    <M-EXAMPLE NAME="Example" TYPE="CORE_LOGIC">
      <purpose>Run the example flow.</purpose>
      <path>src/example.ts</path>
      <depends>none</depends>
      <verification-ref>V-M-EXAMPLE</verification-ref>
      <annotations>
        <fn-run PURPOSE="Run the example flow" />
        <export-run PURPOSE="Public module entry point" />
      </annotations>
    </M-EXAMPLE>
  </Project>
</KnowledgeGraph>`,
  );

  writeProjectFile(
    root,
    "docs/development-plan.xml",
    `<DevelopmentPlan VERSION="0.1.0">
  <Modules>
    <M-EXAMPLE NAME="Example" TYPE="CORE_LOGIC" STATUS="planned">
      <contract>
        <purpose>Run the example flow.</purpose>
      </contract>
      <verification-ref>V-M-EXAMPLE</verification-ref>
    </M-EXAMPLE>
  </Modules>
  <ImplementationOrder>
    <Phase-1 name="Foundation" status="pending">
      <step-1 module="M-EXAMPLE" status="pending" verification="V-M-EXAMPLE">Implement example.</step-1>
    </Phase-1>
  </ImplementationOrder>
</DevelopmentPlan>`,
  );

  writeProjectFile(
    root,
    "docs/verification-plan.xml",
    `<VerificationPlan VERSION="0.1.0">
  <GlobalPolicy>
    <module-level-focus>Fast deterministic checks close to the module.</module-level-focus>
    <wave-level-focus>Checks only merged surfaces touched by a wave.</wave-level-focus>
    <phase-level-focus>Broader regression confidence.</phase-level-focus>
  </GlobalPolicy>
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files>
        <file-1>src/example.test.ts</file-1>
      </test-files>
      <module-checks>
        <command-1>bun test src/example.test.ts</command-1>
      </module-checks>
      <scenarios>
        <scenario-1 kind="success">Primary success path returns ok.</scenario-1>
        <scenario-2 kind="failure">Invalid state is rejected before side effects.</scenario-2>
      </scenarios>
      <required-log-markers>
        <marker-1>[ExampleDomain][run][BLOCK_EXECUTE_FLOW]</marker-1>
      </required-log-markers>
      <required-trace-assertions>
        <assertion-1>Failure path must not emit the success marker.</assertion-1>
      </required-trace-assertions>
      <wave-follow-up>Run the merged example integration path.</wave-follow-up>
      <phase-follow-up>Run the full regression suite before phase completion.</phase-follow-up>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`,
  );

  writeProjectFile(
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
  <GraphDeltaTemplate>
    <GraphDelta />
  </GraphDeltaTemplate>
  <VerificationDeltaTemplate>
    <VerificationDelta />
  </VerificationDeltaTemplate>
  <FailurePacketTemplate>
    <FailurePacket />
  </FailurePacketTemplate>
  <CheckpointReportTemplate>
    <CheckpointReport />
  </CheckpointReportTemplate>
</OperationalPackets>`,
  );
}

describe("lintGraceProject", () => {
  it("passes a well-formed current GRACE project", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "src/example.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Run the example flow.
//   SCOPE: Execute the happy path.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   run - Execute the example flow.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added example module]
// END_CHANGE_SUMMARY
//
// START_CONTRACT: run
//   PURPOSE: Run the example flow.
//   INPUTS: { none }
//   OUTPUTS: { string - flow status }
//   SIDE_EFFECTS: none
//   LINKS: M-EXAMPLE
// END_CONTRACT: run
export function run() {
  // START_BLOCK_EXECUTE_FLOW
  return "ok";
  // END_BLOCK_EXECUTE_FLOW
}
`,
    );

    const result = lintGraceProject(root);
    expect(result.issues).toHaveLength(0);
  });

  it("reports generic XML tags and semantic markup problems", () => {
    const root = createProject();

    writeProjectFile(
      root,
      "docs/knowledge-graph.xml",
      `<KnowledgeGraph>
  <Project NAME="Broken" VERSION="0.1.0">
    <Module ID="M-EXAMPLE">
      <verification-ref>V-M-EXAMPLE</verification-ref>
    </Module>
  </Project>
</KnowledgeGraph>`,
    );

    writeProjectFile(
      root,
      "docs/development-plan.xml",
      `<DevelopmentPlan VERSION="0.1.0">
  <Modules>
    <M-EXAMPLE NAME="Example" TYPE="CORE_LOGIC">
      <verification-ref>V-M-MISSING</verification-ref>
    </M-EXAMPLE>
  </Modules>
  <ImplementationOrder>
    <Phase number="1">
      <step order="1" module="M-EXAMPLE" verification="V-M-MISSING">Broken step.</step>
    </Phase>
  </ImplementationOrder>
</DevelopmentPlan>`,
    );

    writeProjectFile(root, "docs/verification-plan.xml", `<VerificationPlan VERSION="0.1.0" />`);

    writeProjectFile(
      root,
      "src/example.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Broken module.
// END_MODULE_CONTRACT
// START_MODULE_MAP
// END_MODULE_MAP
export function run() {
  // START_BLOCK_DUPLICATE
  return "ok";
  // END_BLOCK_OTHER
}
`,
    );

    const result = lintGraceProject(root);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("xml.generic-module-tag");
    expect(codes).toContain("xml.generic-phase-tag");
    expect(codes).toContain("xml.generic-step-tag");
    expect(codes).toContain("markup.missing-change-summary");
    expect(codes).toContain("markup.empty-module-map");
    expect(codes).toContain("markup.mismatched-block-end");
    expect(codes).toContain("plan.missing-verification-entry");
  });

  it("enforces canonical grep-stable IDs, field labels, and block names", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "docs/knowledge-graph.xml",
      `<KnowledgeGraph>
  <Project NAME="Example" VERSION="0.1.0">
    <M-example NAME="Example" TYPE="CORE_LOGIC">
      <verification-ref>V-M-example</verification-ref>
      <annotations>
        <fn-run PURPOSE="Run the example flow" />
      </annotations>
      <CrossLink source="M-example" target="M-EXAMPLE" relation="reads-config" />
    </M-example>
  </Project>
</KnowledgeGraph>`,
    );

    writeProjectFile(
      root,
      "docs/development-plan.xml",
      `<DevelopmentPlan VERSION="0.1.0">
  <Modules>
    <M-EXAMPLE NAME="Example" TYPE="CORE_LOGIC" STATUS="planned">
      <verification-ref>V-M-EXAMPLE</verification-ref>
    </M-EXAMPLE>
  </Modules>
  <ImplementationOrder>
    <Phase-1 name="Foundation" status="pending">
      <step-1 module="M-example" status="pending" verification="V-M-example">Implement example.</step-1>
    </Phase-1>
  </ImplementationOrder>
</DevelopmentPlan>`,
    );

    writeProjectFile(
      root,
      "src/example.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Run the example flow.
//   SCOPE: Execute the happy path.
//   DEPENDS: none
//   LINKS_TO: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   run - Execute the example flow.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added example module]
// END_CHANGE_SUMMARY
//
// START_CONTRACT: run
//   PURPOSE: Run the example flow.
//   INPUTS: { none }
//   OUTPUT: { string - flow status }
//   SIDE_EFFECTS: none
//   LINKS: M-EXAMPLE
// END_CONTRACT: run
export function run() {
  // START_BLOCK_execute_flow
  return "ok";
  // END_BLOCK_execute_flow
}
`,
    );

    const result = lintGraceProject(root);
    const codes = result.issues.map((issue) => issue.code);

    expect(codes).toContain("xml.invalid-module-id");
    expect(codes).toContain("xml.invalid-verification-id");
    expect(codes).toContain("xml.invalid-crosslink-shape");
    expect(codes).toContain("plan.invalid-module-id");
    expect(codes).toContain("plan.invalid-verification-id");
    expect(codes).toContain("markup.unknown-module-contract-field");
    expect(codes).toContain("markup.unknown-function-contract-field");
    expect(codes).toContain("markup.invalid-block-name");
  });

  it("allows partial repositories when requested", () => {
    const root = createProject();
    writeProjectFile(root, "src/plain.ts", `export const value = 1;\n`);

    const result = lintGraceProject(root, { allowMissingDocs: true });
    expect(result.issues).toHaveLength(0);
  });

  it("treats test files as local-symbol maps instead of export surfaces", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "src/example.test.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Verify example behavior with deterministic test helpers.
//   SCOPE: Test fixtures and assertions for the example runtime.
//   DEPENDS: bun:test, M-EXAMPLE
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   fixture state - In-memory state used across test cases.
//   createExampleContext - Builds a deterministic test context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added deterministic example tests]
// END_CHANGE_SUMMARY

import { describe, expect, it } from "bun:test";

const fixtureState = { count: 1 };

function createExampleContext() {
  return fixtureState;
}

describe("example", () => {
  it("uses the helper", () => {
    expect(createExampleContext().count).toBe(1);
  });
});
`,
    );

    const result = lintGraceProject(root);
    expect(result.issues.filter((issue) => issue.file === "src/example.test.ts")).toHaveLength(0);
  });

  it("treats barrel files as summary maps instead of exact export maps", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "src/barrel.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Barrel export for example runtime surfaces.
//   SCOPE: Re-export stable runtime symbols from child modules.
//   DEPENDS: ./example
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Re-exports all public runtime symbols from child modules.
//   example exports - Stable entry points for external consumers.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added example barrel]
// END_CHANGE_SUMMARY

export * from "./child";
`,
    );

    writeProjectFile(root, "src/child.ts", `export const alpha = 1;\nexport const beta = 2;\n`);

    const result = lintGraceProject(root);
    expect(result.issues.filter((issue) => issue.file === "src/barrel.ts")).toHaveLength(0);
  });

  it("treats configure-style default-export files as config modules", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "src/tool.config.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Configure bundling options for the example application.
//   SCOPE: Default export of the build tool configuration.
//   DEPENDS: tool
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added config file]
// END_CHANGE_SUMMARY

export default {
  mode: "production",
};
`,
    );

    const result = lintGraceProject(root);
    expect(result.issues.filter((issue) => issue.file === "src/tool.config.ts")).toHaveLength(0);
  });

  it("treats script-like files as local-symbol maps instead of export surfaces", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "scripts/smoke-runner.mjs",
      `// START_MODULE_CONTRACT
//   PURPOSE: Execute a smoke runner script for the example workspace.
//   SCOPE: Bootstrap setup, run checks, and print a report.
//   DEPENDS: node:fs
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   main - Run the smoke workflow end to end.
//   runChecks - Execute deterministic smoke checks.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added smoke runner]
// END_CHANGE_SUMMARY

function runChecks() {
  return true;
}

async function main() {
  return runChecks();
}

await main();
`,
    );

    const result = lintGraceProject(root);
    expect(result.issues.filter((issue) => issue.file === "scripts/smoke-runner.mjs")).toHaveLength(0);
  });

  it("supports explicit ROLE and MAP_MODE overrides", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "src/manual-role.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Manual role override example.
//   SCOPE: Demonstrate explicit local-symbol module map behavior.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   helper state - Internal helper state for assertions.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added explicit role example]
// END_CHANGE_SUMMARY

const helperState = 1;

export const exportedValue = helperState;
`,
    );

    const result = lintGraceProject(root);
    expect(result.issues.filter((issue) => issue.file === "src/manual-role.ts")).toHaveLength(0);
  });

  it("uses the Python adapter to verify exact exports from __all__", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "src/example.py",
      `# START_MODULE_CONTRACT
#   PURPOSE: Python runtime example.
#   SCOPE: Expose explicit public helpers through __all__.
#   DEPENDS: none
#   LINKS: M-EXAMPLE
# END_MODULE_CONTRACT
#
# START_MODULE_MAP
#   run_example - Execute the example workflow.
#   ExampleService - Main example service.
# END_MODULE_MAP
#
# START_CHANGE_SUMMARY
#   LAST_CHANGE: [v0.1.0 - Added Python runtime example]
# END_CHANGE_SUMMARY

__all__ = ["run_example", "ExampleService"]

class ExampleService:
    pass


def run_example():
    return "ok"
`,
    );

    const result = lintGraceProject(root);
    expect(result.issues.filter((issue) => issue.file === "src/example.py")).toHaveLength(0);
  });

  it("treats pytest-style Python files as tests with local-symbol maps", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "src/test_example.py",
      `# START_MODULE_CONTRACT
#   PURPOSE: Verify example behavior with pytest fixtures.
#   SCOPE: Test helpers and assertions for the Python runtime.
#   DEPENDS: pytest, M-EXAMPLE
#   LINKS: M-EXAMPLE
# END_MODULE_CONTRACT
#
# START_MODULE_MAP
#   fixture_state - Shared fixture data for tests.
#   build_context - Construct deterministic runtime inputs.
# END_MODULE_MAP
#
# START_CHANGE_SUMMARY
#   LAST_CHANGE: [v0.1.0 - Added Python test example]
# END_CHANGE_SUMMARY

import pytest

fixture_state = {"count": 1}


def build_context():
    return fixture_state


def test_example_flow():
    assert build_context()["count"] == 1
`,
    );

    const result = lintGraceProject(root);
    expect(result.issues.filter((issue) => issue.file === "src/test_example.py")).toHaveLength(0);
  });

  it("infers Python __main__ modules as scripts", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "scripts/run_example.py",
      `# START_MODULE_CONTRACT
#   PURPOSE: Execute the Python smoke script.
#   SCOPE: Build inputs and run the example check.
#   DEPENDS: none
#   LINKS: M-EXAMPLE
# END_MODULE_CONTRACT
#
# START_MODULE_MAP
#   main - Run the smoke workflow.
#   build_input - Build deterministic script input.
# END_MODULE_MAP
#
# START_CHANGE_SUMMARY
#   LAST_CHANGE: [v0.1.0 - Added Python smoke script]
# END_CHANGE_SUMMARY

def build_input():
    return "ok"


def main():
    return build_input()


if __name__ == "__main__":
    main()
`,
    );

    const result = lintGraceProject(root);
    expect(result.issues.filter((issue) => issue.file === "scripts/run_example.py")).toHaveLength(0);
  });

  it("recognizes Clojure-style semicolon markup comments", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "src/example.clj",
      `; START_MODULE_CONTRACT
;   PURPOSE: Clojure example runtime.
;   SCOPE: Demonstrate semicolon-prefixed GRACE markup.
;   DEPENDS: none
;   LINKS: M-EXAMPLE
; END_MODULE_CONTRACT
;
; START_MODULE_MAP
;   run-example - Execute the example workflow.
; END_MODULE_MAP
;
; START_CHANGE_SUMMARY
;   LAST_CHANGE: [v0.1.0 - Added Clojure example]
; END_CHANGE_SUMMARY
`,
    );

    const result = lintGraceProject(root);
    expect(result.issues.filter((issue) => issue.file === "src/example.clj")).toHaveLength(0);
  });

  it("does not misclassify local export lists as barrel re-exports", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "src/local-export-list.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Expose a local export list from a runtime module.
//   SCOPE: Named local exports without barrel semantics.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   run - Execute the local runtime entry point.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added local export list example]
// END_CHANGE_SUMMARY

const run = () => "ok";

export { run };
`,
    );

    const result = lintGraceProject(root);
    expect(result.issues.filter((issue) => issue.file === "src/local-export-list.ts")).toHaveLength(0);
  });

  it("requires verification artifacts even when the repo only has base docs", () => {
    const root = createProject();
    writeBaseDocsWithoutVerification(root);

    writeProjectFile(
      root,
      "src/example.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Run the example flow.
//   SCOPE: Execute the happy path.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   run - Execute the example flow.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added example module]
// END_CHANGE_SUMMARY

export function run() {
  return "ok";
}
`,
    );

    const result = lintGraceProject(root);
    expect(result.issues.map((issue) => issue.code)).toContain("docs.missing-required-artifact");
  });

  it("requires verification artifacts when verification refs are present", () => {
    const root = createProject();

    writeProjectFile(
      root,
      "docs/knowledge-graph.xml",
      `<KnowledgeGraph>
  <Project NAME="Example" VERSION="0.1.0">
    <M-EXAMPLE NAME="Example" TYPE="CORE_LOGIC">
      <verification-ref>V-M-EXAMPLE</verification-ref>
    </M-EXAMPLE>
  </Project>
</KnowledgeGraph>`,
    );
    writeProjectFile(
      root,
      "docs/development-plan.xml",
      `<DevelopmentPlan VERSION="0.1.0">
  <Modules>
    <M-EXAMPLE NAME="Example" TYPE="CORE_LOGIC">
      <verification-ref>V-M-EXAMPLE</verification-ref>
    </M-EXAMPLE>
  </Modules>
</DevelopmentPlan>`,
    );

    const result = lintGraceProject(root);
    expect(result.issues.map((issue) => issue.code)).toContain("docs.missing-required-artifact");
  });

  it("rejects unknown keys in .grace-lint.json", () => {
    const root = createProject();
    writeBaseDocsWithoutVerification(root);
    writeProjectFile(root, ".grace-lint.json", JSON.stringify({ profile: "broken" }, null, 2));

    const result = lintGraceProject(root);
    expect(result.issues.map((issue) => issue.code)).toContain("config.unknown-key");
  });

  it("allows .grace-lint.json with only ignoredDirs", () => {
    const root = createProject();
    writeCurrentDocs(root);
    writeProjectFile(root, ".grace-lint.json", JSON.stringify({ ignoredDirs: ["tmp"] }, null, 2));

    const result = lintGraceProject(root);
    expect(result.issues).toHaveLength(0);
  });

  it("supports the autonomous readiness profile when packets and evidence are complete", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "src/example.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Run the example flow.
//   SCOPE: Execute the happy path.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   run - Execute the example flow.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added example module]
// END_CHANGE_SUMMARY
export function run() {
  console.info("[ExampleDomain][run][BLOCK_EXECUTE_FLOW] ok");
  // START_BLOCK_EXECUTE_FLOW
  return "ok";
  // END_BLOCK_EXECUTE_FLOW
}
`,
    );

    writeProjectFile(
      root,
      "src/example.test.ts",
      `import { expect, test } from "bun:test";
import { run } from "./example";

test("run", () => {
  expect(run()).toBe("ok");
});
`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    expect(result.issues).toHaveLength(0);
  });

  it("reports autonomous readiness gaps when verification metadata is too thin", () => {
    const root = createProject();

    writeProjectFile(
      root,
      "docs/knowledge-graph.xml",
      `<KnowledgeGraph>
  <Project NAME="Example" VERSION="0.1.0">
    <M-EXAMPLE NAME="Example" TYPE="CORE_LOGIC">
      <purpose>Run the example flow.</purpose>
      <path>src/example.ts</path>
    </M-EXAMPLE>
  </Project>
</KnowledgeGraph>`,
    );

    writeProjectFile(
      root,
      "docs/development-plan.xml",
      `<DevelopmentPlan VERSION="0.1.0">
  <Modules>
    <M-EXAMPLE NAME="Example" TYPE="CORE_LOGIC">
      <contract>
        <purpose>Run the example flow.</purpose>
      </contract>
    </M-EXAMPLE>
  </Modules>
  <ImplementationOrder>
    <Phase-1 name="Foundation" status="pending">
      <step-1 module="M-EXAMPLE" status="pending">Implement example.</step-1>
    </Phase-1>
  </ImplementationOrder>
</DevelopmentPlan>`,
    );

    writeProjectFile(
      root,
      "docs/verification-plan.xml",
      `<VerificationPlan VERSION="0.1.0">
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files>
        <file-1>src/example.test.ts</file-1>
      </test-files>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("autonomy.missing-operational-packets");
    expect(codes).toContain("autonomy.missing-technology-artifact");
    expect(codes).toContain("autonomy.module-missing-implementation-files");
    expect(codes).toContain("autonomy.step-missing-verification");
    expect(codes).toContain("autonomy.verification-test-file-missing-on-disk");
    expect(codes).toContain("autonomy.verification-missing-module-checks");
    expect(codes).toContain("autonomy.verification-missing-scenarios");
    expect(codes).toContain("autonomy.verification-missing-observable-evidence");
  });

  it("does not accept required log markers that only appear in tests", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "src/example.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Run the example flow.
//   SCOPE: Execute the happy path.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   run - Execute the example flow.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added example module]
// END_CHANGE_SUMMARY
export function run() {
  // START_BLOCK_EXECUTE_FLOW
  return "ok";
  // END_BLOCK_EXECUTE_FLOW
}
`,
    );

    writeProjectFile(
      root,
      "src/example.test.ts",
      `import { expect, test } from "bun:test";

test("marker expectation only", () => {
  expect("[ExampleDomain][run][BLOCK_EXECUTE_FLOW]").toContain("BLOCK_EXECUTE_FLOW");
});
`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    expect(result.issues.map((issue) => issue.code)).toContain("autonomy.required-log-marker-not-found");
  });

  it("does not accept inert runtime string literals as marker evidence", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "src/example.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Run the example flow.
//   SCOPE: Execute the happy path.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   run - Execute the example flow.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added example module]
// END_CHANGE_SUMMARY
export function run() {
  const marker = "[ExampleDomain][run][BLOCK_EXECUTE_FLOW]";
  // START_BLOCK_EXECUTE_FLOW
  return marker;
  // END_BLOCK_EXECUTE_FLOW
}
`,
    );

    writeProjectFile(
      root,
      "src/example.test.ts",
      `import { expect, test } from "bun:test";
import { run } from "./example";

test("run", () => {
  expect(run()).toContain("BLOCK_EXECUTE_FLOW");
});
`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    expect(result.issues.map((issue) => issue.code)).toContain("autonomy.required-log-marker-not-found");
  });

  it("explains lint issue codes through the CLI", () => {
    const guide = getLintIssueGuide("docs.missing-required-artifact");
    const explanation = formatLintExplanation("docs.missing-required-artifact");

    expect(guide.title).toBe("Missing Required GRACE Artifact");
    expect(guide.remediation.length).toBeGreaterThan(0);
    expect(explanation).toContain("Missing Required GRACE Artifact");
    expect(explanation).toContain("Remediation");
  });

  it("counts a Dart *_test.dart file as a test file, not an implementation file", () => {
    const root = createProject();
    writeCurrentDocs(root);

    // Only linked file for the module is a _test.dart.
    // isLikelyTestPath must filter it out so the gate reports missing implementation.
    writeProjectFile(
      root,
      "lib/example_test.dart",
      `// START_MODULE_CONTRACT
//   PURPOSE: Run the example flow.
//   SCOPE: Test only.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SUMMARY: Dart test file only.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added Dart test]
// END_CHANGE_SUMMARY
`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("autonomy.module-missing-implementation-files");
  });

  it("supports fail-on warnings for CI-oriented lint runs", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "src/example.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Run the example flow.
//   SCOPE: Execute the happy path.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   run - Execute the example flow.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added example module]
// END_CHANGE_SUMMARY
export function run() {
  console.info("[ExampleDomain][run][BLOCK_EXECUTE_FLOW] ok");
  // START_BLOCK_EXECUTE_FLOW
  return "ok";
  // END_BLOCK_EXECUTE_FLOW
}
`,
    );

    writeProjectFile(root, "src/example.test.ts", `export const value = 1;\n`);
    writeProjectFile(
      root,
      "docs/verification-plan.xml",
      `<VerificationPlan VERSION="0.1.0">
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files>
        <file-1>src/example.test.ts</file-1>
      </test-files>
      <module-checks>
        <command-1>bun test src/example.test.ts</command-1>
      </module-checks>
      <scenarios>
        <scenario-1 kind="success">Primary success path returns ok.</scenario-1>
      </scenarios>
      <required-log-markers>
        <marker-1>[ExampleDomain][run][BLOCK_EXECUTE_FLOW]</marker-1>
      </required-log-markers>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`,
    );

    const repoRoot = path.resolve(import.meta.dir, "..");
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", "./src/grace.ts", "lint", "--path", root, "--profile", "autonomous", "--fail-on", "warnings"],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(Buffer.from(result.stdout).toString("utf8")).toContain("Warnings:");
  });
});

// ---------------------------------------------------------------------------
// Helpers shared by export-parity and test-path tests below
// ---------------------------------------------------------------------------

function writeDartBaseDocs(root: string, moduleId = "M-EXAMPLE", sourcePath = "lib/example.dart") {
  writeProjectFile(
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

  writeProjectFile(
    root,
    "docs/knowledge-graph.xml",
    `<KnowledgeGraph>
  <Project NAME="Example" VERSION="0.1.0">
    <${moduleId} NAME="Example" TYPE="CORE_LOGIC">
      <purpose>Example module.</purpose>
      <path>${sourcePath}</path>
      <depends>none</depends>
    </${moduleId}>
  </Project>
</KnowledgeGraph>`,
  );

  writeProjectFile(
    root,
    "docs/development-plan.xml",
    `<DevelopmentPlan VERSION="0.1.0">
  <Modules>
    <${moduleId} NAME="Example" TYPE="CORE_LOGIC" STATUS="planned">
      <contract><purpose>Example module.</purpose></contract>
    </${moduleId}>
  </Modules>
</DevelopmentPlan>`,
  );

  // verification-plan.xml is required by loadGraceArtifactIndex;
  // without it the autonomy check aborts before reaching the impl-files gate.
  writeProjectFile(
    root,
    "docs/verification-plan.xml",
    `<VerificationPlan VERSION="0.1.0" />`,
  );
}

const DART_CONTRACT_HEADER = `// START_MODULE_CONTRACT
//   PURPOSE: Example module.
//   SCOPE: Core logic.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   mySpecialWidget - Public runtime widget not inferred by the regex.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1 - initial]
// END_CHANGE_SUMMARY
`;

// ---------------------------------------------------------------------------
// Task 1 — symmetric extra-export suppression for heuristic adapters
// ---------------------------------------------------------------------------
describe("lintExportMapParity — heuristic adapter extra-export suppression", () => {
  it("heuristic adapter: MODULE_MAP symbol not seen by regex produces no module-map-extra-export (only heuristic-export-surface advisory)", () => {
    const root = createProject();
    writeDartBaseDocs(root);

    // The MODULE_MAP header above lists "mySpecialWidget" but the Dart file
    // only exports "myOtherWidget" — the regex misses the real export, so an
    // accurate MODULE_MAP entry would wrongly fire module-map-extra-export.
    writeProjectFile(
      root,
      "lib/example.dart",
      `${DART_CONTRACT_HEADER}
// A generated widget constructor that the regex won't reliably catch.
class mySpecialWidget {}
`,
    );

    const result = lintGraceProject(root);
    const codes = result.issues.map((i) => i.code);

    // The per-file advisory is still emitted once:
    expect(codes).toContain("analysis.heuristic-export-surface");
    // But no per-symbol extra-export noise:
    expect(codes).not.toContain("markup.module-map-extra-export");
  });

  it("heuristic adapter: symbol only in MODULE_MAP (genuinely absent from file) still produces no module-map-extra-export — suppressed uniformly", () => {
    const root = createProject();
    writeDartBaseDocs(root);

    // MODULE_MAP lists "mySpecialWidget" but the file has nothing matching it.
    // Even so, extra-export must be suppressed for heuristic adapters.
    writeProjectFile(
      root,
      "lib/example.dart",
      `${DART_CONTRACT_HEADER}
class completelyUnrelated {}
`,
    );

    const result = lintGraceProject(root);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain("analysis.heuristic-export-surface");
    expect(codes).not.toContain("markup.module-map-extra-export");
  });

  it("exact adapter (TypeScript): genuinely-extra MODULE_MAP symbol still fires module-map-extra-export", () => {
    const root = createProject();
    writeCurrentDocs(root);

    // MODULE_MAP lists "ghost" but the TS file does not export it.
    writeProjectFile(
      root,
      "src/example.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Run the example flow.
//   SCOPE: Execute the happy path.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   run - Execute the example flow.
//   ghost - This symbol does not exist in the file.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added example module]
// END_CHANGE_SUMMARY
export function run() {
  return "ok";
}
`,
    );

    const result = lintGraceProject(root);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("markup.module-map-extra-export");
  });
});

// ---------------------------------------------------------------------------
// Task 2 — test-path classification: test_ prefix scoping
// ---------------------------------------------------------------------------
describe("isLikelyTestPath — test_ prefix only inside test directories", () => {
  it("lib/core/test_keys.dart is NOT classified as a test path (runtime file)", () => {
    const root = createProject();
    writeDartBaseDocs(root, "M-EXAMPLE", "lib/core/test_keys.dart");

    writeProjectFile(
      root,
      "lib/core/test_keys.dart",
      `// START_MODULE_CONTRACT
//   PURPOSE: Widget-test key constants shipped with the runtime.
//   SCOPE: Test key string constants used in integration tests.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   kLoginButtonKey - Test key for the login button.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1 - initial]
// END_CHANGE_SUMMARY
const kLoginButtonKey = 'login_button';
`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    // Must NOT be excluded as a test file — the module should NOT report missing implementation files.
    expect(codes).not.toContain("autonomy.module-missing-implementation-files");
  });

  it("test/foo_test.dart IS classified as a test path", () => {
    const root = createProject();
    // Module path points to a runtime file; the test file is only a sibling.
    writeDartBaseDocs(root, "M-EXAMPLE", "lib/example.dart");

    writeProjectFile(
      root,
      "lib/example.dart",
      `// START_MODULE_CONTRACT
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
void run() {}
`,
    );

    // The _test.dart suffix is an unambiguous signal regardless of directory.
    writeProjectFile(root, "test/foo_test.dart", `void main() {}`);

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    // lib/example.dart is the implementation; test/foo_test.dart is excluded.
    // Module should NOT report missing implementation files.
    expect(codes).not.toContain("autonomy.module-missing-implementation-files");
  });

  it("test/test_helpers.dart IS classified as a test path (test/ ancestor)", () => {
    const root = createProject();
    // Only file linked to the module is test/test_helpers.dart — it lives
    // under test/ so it must be filtered out as a test file, leaving no impl files.
    writeDartBaseDocs(root, "M-EXAMPLE", "test/test_helpers.dart");

    writeProjectFile(
      root,
      "test/test_helpers.dart",
      `// START_MODULE_CONTRACT
//   PURPOSE: Test helper utilities.
//   SCOPE: Shared test utilities.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   createFakeUser - Build a fake user object.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1 - initial]
// END_CHANGE_SUMMARY
void createFakeUser() {}
`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    // The only file is a test helper; after filtering, no impl file → missing impl.
    expect(codes).toContain("autonomy.module-missing-implementation-files");
  });

  it("src/x.test.ts IS classified as a test path (unambiguous .test. suffix)", () => {
    const root = createProject();
    // Only file linked to the module is src/x.test.ts.
    writeCurrentDocs(root);

    // Override the knowledge-graph path to the test file only.
    writeProjectFile(
      root,
      "docs/knowledge-graph.xml",
      `<KnowledgeGraph>
  <Project NAME="Example" VERSION="0.1.0">
    <M-EXAMPLE NAME="Example" TYPE="CORE_LOGIC">
      <purpose>Run the example flow.</purpose>
      <path>src/x.test.ts</path>
      <depends>none</depends>
      <verification-ref>V-M-EXAMPLE</verification-ref>
      <annotations>
        <fn-run PURPOSE="Run the example flow" />
        <export-run PURPOSE="Public module entry point" />
      </annotations>
    </M-EXAMPLE>
  </Project>
</KnowledgeGraph>`,
    );

    writeProjectFile(
      root,
      "src/x.test.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Run the example flow.
//   SCOPE: Test only.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SUMMARY: Test file only.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1 - initial]
// END_CHANGE_SUMMARY
export const x = 1;
`,
    );

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    // .test.ts suffix is unambiguous — file is excluded as a test file.
    expect(codes).toContain("autonomy.module-missing-implementation-files");
  });
});

// ---------------------------------------------------------------------------
// FIX-6: lintScopedMarkers must not count markers inside string literals
// ---------------------------------------------------------------------------

// De-literalize block anchors at runtime so this source file does not contain
// literal START_BLOCK_<NAME> / END_BLOCK_<NAME> tokens (avoids self-lint debt).
const BLOCK_OPEN = (name: string) => `// ${"START"}_${"BLOCK"}_${name}`;
const BLOCK_CLOSE = (name: string) => `// ${"END"}_${"BLOCK"}_${name}`;

describe("FIX-6 — lintScopedMarkers string-literal false-positive", () => {
  it("a marker-looking token inside a string literal does NOT raise duplicate-block-name", () => {
    const root = createProject();
    writeCurrentDocs(root);

    // The file has one real // START_BLOCK_FOO / END_BLOCK_FOO pair (in comments).
    // It also has the same token embedded inside a string literal.
    // After fix: only the real comment markers are counted → no duplicate.
    writeProjectFile(
      root,
      "src/example.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Run the example flow.
//   SCOPE: Execute the happy path.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   run - Execute the example flow.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - FIX-6 test]
// END_CHANGE_SUMMARY
export function run() {
  // The string below contains a marker-looking token — must not be counted.
  const label = "${"START"}_${"BLOCK"}_FOO inside a string, not real markup";
  ${BLOCK_OPEN("FOO")}
  return label;
  ${BLOCK_CLOSE("FOO")}
}
`,
    );

    const result = lintGraceProject(root);
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain("markup.duplicate-block-name");
  });

  it("two real // START_BLOCK_FOO comment lines (not in strings) still raise duplicate-block-name", () => {
    const root = createProject();
    writeCurrentDocs(root);

    writeProjectFile(
      root,
      "src/example.ts",
      `// START_MODULE_CONTRACT
//   PURPOSE: Run the example flow.
//   SCOPE: Execute the happy path.
//   DEPENDS: none
//   LINKS: M-EXAMPLE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   run - Execute the example flow.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - FIX-6 duplicate test]
// END_CHANGE_SUMMARY
export function run() {
  ${BLOCK_OPEN("FOO")}
  const x = 1;
  ${BLOCK_CLOSE("FOO")}
  ${BLOCK_OPEN("FOO")}
  return x;
  ${BLOCK_CLOSE("FOO")}
}
`,
    );

    const result = lintGraceProject(root);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("markup.duplicate-block-name");
  });
});

// ---------------------------------------------------------------------------
// PATCH B — external-module lint exemptions (lintAutonomousReadiness)
// ---------------------------------------------------------------------------

/**
 * Write a minimal full docs set for an external/integration module with no
 * local implementation files.  Callers can override individual docs after.
 */
function writeExternalModuleDocs(
  root: string,
  opts: {
    moduleType?: string;
    graphPath?: string;
    withVerification?: boolean;
  } = {},
) {
  const {
    moduleType = "CORE_LOGIC",
    graphPath = "src/example.ts",
    withVerification = true,
  } = opts;

  writeProjectFile(
    root,
    "docs/technology.xml",
    `<TechnologyStack VERSION="0.2.0">
  <Runtime>bun 1.3.8</Runtime>
  <Language>typescript 6.x</Language>
  <PreferredAgentStack>
    <preferred-runtime-library>bun</preferred-runtime-library>
    <preferred-test-library>bun:test</preferred-test-library>
  </PreferredAgentStack>
  <AutonomyPolicy>
    <default-execution-profile>balanced</default-execution-profile>
    <max-fix-attempts-per-step>2</max-fix-attempts-per-step>
  </AutonomyPolicy>
</TechnologyStack>`,
  );

  writeProjectFile(
    root,
    "docs/knowledge-graph.xml",
    `<KnowledgeGraph>
  <Project NAME="Example" VERSION="0.1.0">
    <M-EXAMPLE NAME="Example" TYPE="${moduleType}">
      <purpose>External dependency module.</purpose>
      <path>${graphPath}</path>
      <depends>none</depends>${withVerification ? "\n      <verification-ref>V-M-EXAMPLE</verification-ref>" : ""}
    </M-EXAMPLE>
  </Project>
</KnowledgeGraph>`,
  );

  writeProjectFile(
    root,
    "docs/development-plan.xml",
    `<DevelopmentPlan VERSION="0.1.0">
  <Modules>
    <M-EXAMPLE NAME="Example" TYPE="${moduleType}" STATUS="planned">
      <contract><purpose>External dependency module.</purpose></contract>
      ${withVerification ? "<verification-ref>V-M-EXAMPLE</verification-ref>" : ""}
    </M-EXAMPLE>
  </Modules>
</DevelopmentPlan>`,
  );

  const verificationPlanXml = withVerification
    ? `<VerificationPlan VERSION="0.1.0">
  <ModuleVerification>
    <V-M-EXAMPLE MODULE="M-EXAMPLE">
      <test-files><file-1>src/example.test.ts</file-1></test-files>
      <module-checks><command-1>bun test src/example.test.ts</command-1></module-checks>
      <scenarios><scenario-1 kind="success">Happy path.</scenario-1></scenarios>
      <required-log-markers><marker-1>[ExampleDomain][run][BLOCK_EXECUTE_FLOW]</marker-1></required-log-markers>
    </V-M-EXAMPLE>
  </ModuleVerification>
</VerificationPlan>`
    : `<VerificationPlan VERSION="0.1.0" />`;

  writeProjectFile(root, "docs/verification-plan.xml", verificationPlanXml);

  writeProjectFile(
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
  <GraphDeltaTemplate><GraphDelta /></GraphDeltaTemplate>
  <VerificationDeltaTemplate><VerificationDelta /></VerificationDeltaTemplate>
  <FailurePacketTemplate><FailurePacket /></FailurePacketTemplate>
  <CheckpointReportTemplate><CheckpointReport /></CheckpointReportTemplate>
</OperationalPackets>`,
  );
}

describe("PATCH B — external-module autonomy exemption", () => {
  it("B1: module with path /^external\\b/ and no local files does NOT raise module-missing-implementation-files", () => {
    // External path (e.g. a git submodule / vendored dep declared by path starting
    // with "external") means there are no governed source files in the repo.
    // The autonomy linter must skip the impl-surface check for such modules.
    const root = createProject();
    writeExternalModuleDocs(root, {
      moduleType: "CORE_LOGIC",
      graphPath: "external (git.example.com/org/dep)",
      withVerification: true,
    });
    // No source file written — intentionally zero local files.

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain("autonomy.module-missing-implementation-files");
  });

  it("B2: module with TYPE=INTEGRATION and no local files does NOT raise module-missing-implementation-files", () => {
    // INTEGRATION modules represent external service boundaries; they have no
    // local implementation files by design.  The type-based branch must exempt them.
    const root = createProject();
    writeExternalModuleDocs(root, {
      moduleType: "INTEGRATION",
      graphPath: "src/integrations/payment-gateway.ts",
      withVerification: true,
    });
    // No source file written — intentionally zero local files.

    const result = lintGraceProject(root, { profile: "autonomous" });
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain("autonomy.module-missing-implementation-files");
  });

  it("B3: external module (path-based) with no V-M entry emits module-missing-verification as warning, not error", () => {
    // External modules still need a verification plan entry, but the severity is
    // downgraded to warning (non-blocking) because the impl surface is not local.
    const root = createProject();
    writeExternalModuleDocs(root, {
      moduleType: "CORE_LOGIC",
      graphPath: "external (git.example.com/org/dep)",
      withVerification: false,
    });
    // No source file written — intentionally zero local files.

    const result = lintGraceProject(root, { profile: "autonomous" });
    const verificationIssues = result.issues.filter(
      (i) => i.code === "autonomy.module-missing-verification",
    );
    expect(verificationIssues.length).toBeGreaterThan(0);
    // Must be downgraded to warning, not an error.
    for (const issue of verificationIssues) {
      expect(issue.severity).toBe("warning");
    }
    // warning must NOT inflate the error count.
    expect(result.summary.errors).toBe(0);
  });

  it("B4: non-external module (TYPE=CORE_LOGIC, normal path) with no local files STILL raises module-missing-implementation-files as error", () => {
    // Proves the exemption is scoped only to external/INTEGRATION modules;
    // ordinary modules must still fail the impl-surface gate.
    const root = createProject();
    writeExternalModuleDocs(root, {
      moduleType: "CORE_LOGIC",
      graphPath: "src/example.ts",
      withVerification: true,
    });
    // No source file written — intentionally zero local files.

    const result = lintGraceProject(root, { profile: "autonomous" });
    const implIssues = result.issues.filter(
      (i) => i.code === "autonomy.module-missing-implementation-files",
    );
    expect(implIssues.length).toBeGreaterThan(0);
    for (const issue of implIssues) {
      expect(issue.severity).toBe("error");
    }
  });
});
