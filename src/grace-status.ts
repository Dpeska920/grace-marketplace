#!/usr/bin/env bun

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { defineCommand, type CommandDef, runMain } from "citty";

import { loadGraceLintConfig } from "./lint/config";
import { lintGraceProject } from "./lint/core";
import type { LintIssue } from "./lint/types";
import { loadGraceArtifactIndex } from "./query/core";
import { collectModuleHealth } from "./query/health";
import { formatModuleHealthTable } from "./query/render";
import type { ModuleHealthRecord } from "./query/types";
import {
  collectCodeFiles,
  findSection,
  hasGraceMarkers,
  isLikelyTestPath,
  readTextIfExists,
  stripCommentPrefix,
  stripQuotedStrings,
} from "./project-utils";

type ArtifactStatus = {
  path: string;
  exists: boolean;
  version?: string;
  count?: number;
  countLabel?: string;
};

type RecentChange = {
  path: string;
  summary: string;
  modifiedAt: string;
};

type CodebaseMetrics = {
  sourceFiles: number;
  sourceFilesWithModuleContract: number;
  sourceFilesWithoutModuleContract: number;
  testFiles: number;
  testFilesWithModuleContract: number;
  governedFiles: number;
  semanticBlocks: number;
  unpairedBlockIssues: number;
  filesWithStableLogMarkers: number;
  testFilesWithEvidenceAssertions: number;
};

type HealthSnapshot = {
  graphModules: number;
  planModules: number;
  codebaseModules: number;
  graphOnlyModules: string[];
  planOnlyModules: string[];
  sharedModulesWithoutGovernedFiles: string[];
  governedModulesMissingFromSharedDocs: string[];
  modulesWithoutVerification: string[];
  staleVerificationEntries: string[];
  pendingPhases: number;
  pendingSteps: number;
};

export type StatusResult = {
  schemaVersion: string;
  tool: "grace-status";
  generatedAt: string;
  root: string;
  summary: {
    moduleSummaryLoaded: boolean;
    moduleCount: number;
    readyModules: number;
    attentionModules: number;
    blockedModules: number;
    integrityErrors: number;
    integrityWarnings: number;
    autonomyBlockers: number;
    autonomyWarnings: number;
  };
  artifacts: ArtifactStatus[];
  metrics: CodebaseMetrics;
  health: HealthSnapshot;
  integrity: {
    errors: number;
    warnings: number;
    topIssues: string[];
  };
  autonomy: {
    ready: boolean;
    blockers: string[];
    warnings: string[];
  };
  recentChanges: RecentChange[];
  nextAction: string;
  modules?: ModuleHealthRecord[];
  moduleHealthLoadError?: string;
};

type ScannedFile = {
  path: string;
  isTest: boolean;
  hasGraceMarkers: boolean;
  hasModuleContract: boolean;
  linkedModuleIds: string[];
  blockCount: number;
  hasStableLogMarkers: boolean;
  hasEvidenceAssertions: boolean;
  lastChange: string | null;
  modifiedAt: number;
};

function toPosixPath(filePath: string) {
  return filePath.replaceAll(path.sep, "/");
}

function normalizeRelative(root: string, filePath: string) {
  return toPosixPath(path.relative(root, filePath) || ".");
}

function extractVersion(text: string | null) {
  if (!text) {
    return undefined;
  }

  return text.match(/\bVERSION="([^"]+)"/)?.[1];
}

function countUniqueMatches(text: string | null, regex: RegExp) {
  if (!text) {
    return 0;
  }

  return new Set(Array.from(text.matchAll(regex), (match) => match[1])).size;
}

function splitList(value?: string) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.toLowerCase() !== "none");
}

function hasCommentMarker(searchableText: string, marker: string) {
  return searchableText
    .split("\n")
    .some((line) => new RegExp(`^\\s*(\\/\\/|#|--|;+|\\*)\\s*${marker}\\b`).test(line));
}

function countCommentMarkers(searchableText: string, markerPattern: string) {
  return searchableText
    .split("\n")
    .filter((line) => new RegExp(`^\\s*(\\/\\/|#|--|;+|\\*)\\s*${markerPattern}\\b`).test(line)).length;
}

function parseFieldSection(text: string | null) {
  if (!text) {
    return {} as Record<string, string>;
  }

  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const cleaned = stripCommentPrefix(line).trim();
    if (!cleaned) {
      continue;
    }

    const match = cleaned.match(/^([A-Z_]+):\s*(.+)$/);
    if (!match) {
      continue;
    }

    fields[match[1]] = match[2].trim();
  }

  return fields;
}

// isLikelyTestPath — imported from project-utils (canonical shared helper).

function scanCodebase(root: string): ScannedFile[] {
  const { config } = loadGraceLintConfig(root);
  const ignoredDirs = Array.isArray(config?.ignoredDirs) ? config.ignoredDirs : [];

  return collectCodeFiles(root, ignoredDirs).map((filePath) => {
    const relativePath = normalizeRelative(root, filePath);
    const text = readFileSync(filePath, "utf8");
    const searchable = stripQuotedStrings(text);
    const hasContract = hasCommentMarker(searchable, "START_MODULE_CONTRACT") && hasCommentMarker(searchable, "END_MODULE_CONTRACT");
    const hasChangeSummary = hasCommentMarker(searchable, "START_CHANGE_SUMMARY") && hasCommentMarker(searchable, "END_CHANGE_SUMMARY");
    const contractFields = parseFieldSection(
      hasContract ? findSection(searchable, "START_MODULE_CONTRACT", "END_MODULE_CONTRACT")?.content ?? null : null,
    );
    const changeFields = parseFieldSection(
      hasChangeSummary ? findSection(searchable, "START_CHANGE_SUMMARY", "END_CHANGE_SUMMARY")?.content ?? null : null,
    );
    const stableMarkerRegex = /\[[^\]]+\]\[[^\]]+\]\[BLOCK_[A-Z0-9_]+\]/;
    const isTest = isLikelyTestPath(relativePath);

    return {
      path: relativePath,
      isTest,
      hasGraceMarkers: hasGraceMarkers(text),
      hasModuleContract: hasContract,
      linkedModuleIds: splitList(contractFields.LINKS).filter((item) => /^M-[A-Za-z0-9-]+$/.test(item)),
      blockCount: countCommentMarkers(searchable, "START_BLOCK_[A-Za-z0-9_]+"),
      hasStableLogMarkers: hasContract && stableMarkerRegex.test(text),
      hasEvidenceAssertions: isTest && hasContract && (stableMarkerRegex.test(text) || /\btrace\b|log marker|BLOCK_[A-Z0-9_]+/.test(text)),
      lastChange: changeFields.LAST_CHANGE ?? null,
      modifiedAt: statSync(filePath).mtimeMs,
    } satisfies ScannedFile;
  });
}

function artifactStatus(relativePath: string, text: string | null, countLabel?: string, count?: number): ArtifactStatus {
  return {
    path: relativePath,
    exists: Boolean(text),
    version: extractVersion(text),
    countLabel,
    count,
  };
}

function topIssues(issues: LintIssue[]) {
  return issues.slice(0, 5).map((issue) => `${issue.code}: ${issue.file}${issue.line ? `:${issue.line}` : ""} ${issue.message}`);
}

function formatList(label: string, items: string[]) {
  return `${label}: ${items.length > 0 ? items.join(", ") : "none"}`;
}

function countPendingPhases(text: string | null) {
  if (!text) {
    return 0;
  }

  return Array.from(text.matchAll(/<(Phase-[A-Za-z0-9-]+)\b[^>]*\bstatus="(pending|in-progress)"/g)).length;
}

function countPendingSteps(text: string | null) {
  if (!text) {
    return 0;
  }

  return Array.from(text.matchAll(/<(step-[A-Za-z0-9-]+)\b[^>]*\bstatus="(pending|in-progress)"/g)).length;
}

function suggestNextAction(input: {
  hasRequirements: boolean;
  hasTechnology: boolean;
  hasPlan: boolean;
  hasGraph: boolean;
  hasVerification: boolean;
  integrityErrors: number;
  autonomyBlockers: number;
  pendingPhases: number;
  pendingSteps: number;
  sharedModulesWithoutGovernedFiles: number;
}) {
  if (!input.hasRequirements) {
    return "Define requirements in docs/requirements.xml.";
  }

  if (!input.hasTechnology) {
    return "Define stack and preferred agent tooling in docs/technology.xml.";
  }

  if (!input.hasPlan || !input.hasGraph) {
    return "Run $grace-plan to create or refresh the development plan and knowledge graph.";
  }

  if (!input.hasVerification) {
    return "Run $grace-verification to build verification-plan.xml before execution.";
  }

  if (input.integrityErrors > 0) {
    return "Run grace lint --path <project-root> and fix the reported GRACE integrity issues. Use $grace-refresh if shared docs drifted from the codebase.";
  }

  if (input.autonomyBlockers > 0) {
    return "Run grace lint --profile autonomous --path <project-root> and strengthen verification entries, operational packets, or execution checkpoints before autonomous runs.";
  }

  if (input.pendingPhases > 0 || input.pendingSteps > 0 || input.sharedModulesWithoutGovernedFiles > 0) {
    return "Run $grace-execute or $grace-multiagent-execute for the remaining planned modules.";
  }

  return "Project is healthy.";
}

export function collectProjectStatus(projectRoot: string, options: { includeModules?: boolean } = {}): StatusResult {
  const root = path.resolve(projectRoot);
  const docs = {
    agents: readTextIfExists(path.join(root, "AGENTS.md")),
    requirements: readTextIfExists(path.join(root, "docs/requirements.xml")),
    technology: readTextIfExists(path.join(root, "docs/technology.xml")),
    graph: readTextIfExists(path.join(root, "docs/knowledge-graph.xml")),
    plan: readTextIfExists(path.join(root, "docs/development-plan.xml")),
    verification: readTextIfExists(path.join(root, "docs/verification-plan.xml")),
    packets: readTextIfExists(path.join(root, "docs/operational-packets.xml")),
  };

  const scannedFiles = scanCodebase(root);
  const autonomousLint = lintGraceProject(root, { allowMissingDocs: false, profile: "autonomous" });
  let modules: ModuleHealthRecord[] | undefined;
  let moduleHealthLoadError: string | undefined;
  if (options.includeModules && docs.graph && docs.plan && docs.verification) {
    try {
      modules = collectModuleHealth(loadGraceArtifactIndex(root));
    } catch (error) {
      moduleHealthLoadError = error instanceof Error ? error.message : String(error);
    }
  }

  const graphModuleIds = new Set(Array.from((docs.graph ?? "").matchAll(/<(M-[A-Za-z0-9-]+)(?=[\s>])/g), (match) => match[1]));
  const planModuleIds = new Set(Array.from((docs.plan ?? "").matchAll(/<(M-[A-Za-z0-9-]+)(?=[\s>])/g), (match) => match[1]));
  const verificationModuleIds = new Set(Array.from((docs.verification ?? "").matchAll(/<V-M-[A-Za-z0-9-]+\b[^>]*\bMODULE="(M-[A-Za-z0-9-]+)"/g), (match) => match[1]));
  const codebaseModuleIds = new Set(scannedFiles.filter((file) => !file.isTest).flatMap((file) => file.linkedModuleIds));
  const sharedModuleIds = new Set([...graphModuleIds, ...planModuleIds]);

  const artifacts: ArtifactStatus[] = [
    {
      path: "AGENTS.md",
      exists: Boolean(docs.agents),
    },
    artifactStatus("docs/requirements.xml", docs.requirements, "use cases", countUniqueMatches(docs.requirements, /<(UC-[A-Za-z0-9-]+)(?=[\s>])/g)),
    artifactStatus("docs/technology.xml", docs.technology),
    artifactStatus("docs/knowledge-graph.xml", docs.graph, "modules", graphModuleIds.size),
    artifactStatus("docs/development-plan.xml", docs.plan, "modules", planModuleIds.size),
    artifactStatus(
      "docs/verification-plan.xml",
      docs.verification,
      "verification entries",
      countUniqueMatches(docs.verification, /<(V-M-[A-Za-z0-9-]+)(?=[\s>])/g),
    ),
    artifactStatus("docs/operational-packets.xml", docs.packets),
  ];

  const metrics: CodebaseMetrics = {
    sourceFiles: scannedFiles.filter((file) => !file.isTest).length,
    sourceFilesWithModuleContract: scannedFiles.filter((file) => !file.isTest && file.hasModuleContract).length,
    sourceFilesWithoutModuleContract: scannedFiles.filter((file) => !file.isTest && !file.hasModuleContract).length,
    testFiles: scannedFiles.filter((file) => file.isTest).length,
    testFilesWithModuleContract: scannedFiles.filter((file) => file.isTest && file.hasModuleContract).length,
    governedFiles: scannedFiles.filter((file) => file.hasGraceMarkers).length,
    semanticBlocks: scannedFiles.reduce((sum, file) => sum + file.blockCount, 0),
    unpairedBlockIssues: autonomousLint.issues.filter((issue) =>
      ["markup.unmatched-block-end", "markup.mismatched-block-end", "markup.missing-block-end"].includes(issue.code)
    ).length,
    filesWithStableLogMarkers: scannedFiles.filter((file) => file.hasStableLogMarkers).length,
    testFilesWithEvidenceAssertions: scannedFiles.filter((file) => file.isTest && file.hasEvidenceAssertions).length,
  };

  const health: HealthSnapshot = {
    graphModules: graphModuleIds.size,
    planModules: planModuleIds.size,
    codebaseModules: codebaseModuleIds.size,
    graphOnlyModules: Array.from(graphModuleIds).filter((moduleId) => !planModuleIds.has(moduleId)).sort(),
    planOnlyModules: Array.from(planModuleIds).filter((moduleId) => !graphModuleIds.has(moduleId)).sort(),
    sharedModulesWithoutGovernedFiles: Array.from(sharedModuleIds).filter((moduleId) => !codebaseModuleIds.has(moduleId)).sort(),
    governedModulesMissingFromSharedDocs: Array.from(codebaseModuleIds).filter((moduleId) => !sharedModuleIds.has(moduleId)).sort(),
    modulesWithoutVerification: Array.from(sharedModuleIds).filter((moduleId) => !verificationModuleIds.has(moduleId)).sort(),
    staleVerificationEntries: Array.from(verificationModuleIds).filter((moduleId) => !sharedModuleIds.has(moduleId)).sort(),
    pendingPhases: countPendingPhases(docs.plan),
    pendingSteps: countPendingSteps(docs.plan),
  };

  const recentChanges = scannedFiles
    .filter((file) => file.lastChange)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, 5)
    .map((file) => ({
      path: file.path,
      summary: file.lastChange as string,
      modifiedAt: new Date(file.modifiedAt).toISOString(),
    })) satisfies RecentChange[];

  const integrityErrors = autonomousLint.issues.filter(
    (issue) => issue.severity === "error" && !issue.code.startsWith("autonomy."),
  );
  const integrityWarnings = autonomousLint.issues.filter(
    (issue) => issue.severity === "warning" && !issue.code.startsWith("autonomy."),
  );
  const autonomyBlockers = autonomousLint.issues.filter(
    (issue) => issue.severity === "error" && issue.code.startsWith("autonomy."),
  );
  const autonomyWarnings = autonomousLint.issues.filter(
    (issue) => issue.severity === "warning" && issue.code.startsWith("autonomy."),
  );
  const moduleCount = modules?.length ?? sharedModuleIds.size;
  const readyModules = modules?.filter((module) => module.state === "ready").length ?? 0;
  const attentionModules = modules?.filter((module) => module.state === "attention").length ?? 0;
  const blockedModules = modules?.filter((module) => module.state === "blocked").length ?? 0;
  const moduleSummaryLoaded = Boolean(modules);

  return {
    schemaVersion: "1.0.0",
    tool: "grace-status",
    generatedAt: new Date().toISOString(),
    root,
    summary: {
      moduleSummaryLoaded,
      moduleCount,
      readyModules,
      attentionModules,
      blockedModules,
      integrityErrors: integrityErrors.length,
      integrityWarnings: integrityWarnings.length,
      autonomyBlockers: autonomyBlockers.length,
      autonomyWarnings: autonomyWarnings.length,
    },
    artifacts,
    metrics,
    health,
    integrity: {
      errors: integrityErrors.length,
      warnings: integrityWarnings.length,
      topIssues: topIssues([...integrityErrors, ...integrityWarnings]),
    },
    autonomy: {
      ready: autonomyBlockers.length === 0,
      blockers: topIssues(autonomyBlockers),
      warnings: topIssues(autonomyWarnings),
    },
    recentChanges,
    nextAction: suggestNextAction({
      hasRequirements: Boolean(docs.requirements),
      hasTechnology: Boolean(docs.technology),
      hasPlan: Boolean(docs.plan),
      hasGraph: Boolean(docs.graph),
      hasVerification: Boolean(docs.verification),
      integrityErrors: integrityErrors.length,
      autonomyBlockers: autonomyBlockers.length,
      pendingPhases: health.pendingPhases,
      pendingSteps: health.pendingSteps,
      sharedModulesWithoutGovernedFiles: health.sharedModulesWithoutGovernedFiles.length,
    }),
    modules,
    moduleHealthLoadError,
  };
}

export function formatStatusText(result: StatusResult) {
  const lines = [
    "GRACE Status",
    "============",
    `Root: ${result.root}`,
    "",
    "Artifacts",
  ];

  for (const artifact of result.artifacts) {
    const details = [artifact.exists ? "present" : "missing"];
    if (artifact.version) {
      details.push(`version ${artifact.version}`);
    }
    if (artifact.countLabel && artifact.count !== undefined) {
      details.push(`${artifact.countLabel}: ${artifact.count}`);
    }
    lines.push(`- ${artifact.path}: ${details.join(", ")}`);
  }

  lines.push(
    "",
    "Summary",
    result.summary.moduleSummaryLoaded
      ? `- Modules: ${result.summary.moduleCount} total, ${result.summary.readyModules} ready, ${result.summary.attentionModules} attention, ${result.summary.blockedModules} blocked`
      : `- Modules: ${result.summary.moduleCount} shared modules discovered (use --with modules for health states)`,
    `- Integrity: ${result.summary.integrityErrors} errors, ${result.summary.integrityWarnings} warnings`,
    `- Autonomy: ${result.summary.autonomyBlockers} blockers, ${result.summary.autonomyWarnings} warnings`,
    "",
    "Codebase Metrics",
    `- Source files: ${result.metrics.sourceFiles}`,
    `- Source files with MODULE_CONTRACT: ${result.metrics.sourceFilesWithModuleContract}`,
    `- Source files without MODULE_CONTRACT: ${result.metrics.sourceFilesWithoutModuleContract}`,
    `- Test files: ${result.metrics.testFiles}`,
    `- Test files with MODULE_CONTRACT: ${result.metrics.testFilesWithModuleContract}`,
    `- Governed files: ${result.metrics.governedFiles}`,
    `- Semantic blocks: ${result.metrics.semanticBlocks}`,
    `- Unpaired block issues: ${result.metrics.unpairedBlockIssues}`,
    `- Files with stable log markers: ${result.metrics.filesWithStableLogMarkers}`,
    `- Test files with evidence assertions: ${result.metrics.testFilesWithEvidenceAssertions}`,
    "",
    "Knowledge Graph and Verification Health",
    `- Graph modules: ${result.health.graphModules}`,
    `- Plan modules: ${result.health.planModules}`,
    `- Codebase-linked modules: ${result.health.codebaseModules}`,
    `- Pending phases: ${result.health.pendingPhases}`,
    `- Pending steps: ${result.health.pendingSteps}`,
    `- ${formatList("Graph-only modules", result.health.graphOnlyModules)}`,
    `- ${formatList("Plan-only modules", result.health.planOnlyModules)}`,
    `- ${formatList("Shared modules without governed files", result.health.sharedModulesWithoutGovernedFiles)}`,
    `- ${formatList("Governed modules missing from shared docs", result.health.governedModulesMissingFromSharedDocs)}`,
    `- ${formatList("Modules without verification", result.health.modulesWithoutVerification)}`,
    `- ${formatList("Stale verification entries", result.health.staleVerificationEntries)}`,
    "",
    "Integrity Snapshot",
    `- Standard lint: ${result.integrity.errors} errors, ${result.integrity.warnings} warnings`,
    `- Autonomy gate: ${result.autonomy.ready ? "READY" : "BLOCKED"}`,
  );

  if (result.integrity.topIssues.length > 0) {
    lines.push(...result.integrity.topIssues.map((issue) => `- Integrity issue: ${issue}`));
  }

  if (result.autonomy.blockers.length > 0) {
    lines.push(...result.autonomy.blockers.map((issue) => `- Autonomy blocker: ${issue}`));
  }

  if (result.autonomy.warnings.length > 0) {
    lines.push(...result.autonomy.warnings.map((issue) => `- Autonomy warning: ${issue}`));
  }

  if (result.modules && result.modules.length > 0) {
    lines.push("", "Module Health", formatModuleHealthTable(result.modules));
  } else if (result.moduleHealthLoadError) {
    lines.push("", "Module Health", `- unavailable: ${result.moduleHealthLoadError}`);
  }

  lines.push("", "Recent Changes");
  if (result.recentChanges.length === 0) {
    lines.push("- none");
  } else {
    for (const change of result.recentChanges) {
      lines.push(`- ${change.path}: ${change.summary}`);
    }
  }

  lines.push("", "Suggested Next Action", `- ${result.nextAction}`);

  return lines.join("\n");
}

function resolveFormat(format: unknown, json: unknown) {
  const resolved = Boolean(json) ? "json" : String(format ?? "text");
  if (resolved !== "text" && resolved !== "json") {
    throw new Error(`Unsupported format \`${resolved}\`. Use \`text\` or \`json\`.`);
  }

  return resolved;
}

function resolveWithList(value: unknown) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function resolveFailOn(value: unknown) {
  const failOn = String(value ?? "never");
  if (failOn !== "never" && failOn !== "errors" && failOn !== "warnings") {
    throw new Error(`Unsupported fail-on policy \`${failOn}\`. Use \`never\`, \`errors\`, or \`warnings\`.`);
  }

  return failOn;
}

function shouldFail(result: StatusResult, failOn: string) {
  const errorCount = result.summary.integrityErrors
    + result.summary.autonomyBlockers
    + (result.summary.moduleSummaryLoaded ? result.summary.blockedModules : 0);
  const warningCount = result.summary.integrityWarnings
    + result.summary.autonomyWarnings
    + (result.summary.moduleSummaryLoaded ? result.summary.attentionModules : 0);
  if (failOn === "never") {
    return false;
  }

  if (failOn === "warnings") {
    return errorCount + warningCount > 0;
  }

  return errorCount > 0;
}

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show GRACE artifact health, integrity signals, autonomy readiness, and the next recommended action.",
  },
  args: {
    path: {
      type: "string",
      alias: "p",
      description: "Project root to inspect",
      default: ".",
    },
    format: {
      type: "string",
      alias: "f",
      description: "Output format: text or json",
      default: "text",
    },
    json: {
      type: "boolean",
      description: "Shortcut for --format json",
      default: false,
    },
    with: {
      type: "string",
      description: "Optional extras, currently supports: modules",
      default: "",
    },
    failOn: {
      type: "string",
      description: "Exit policy: never, errors, or warnings",
      default: "never",
    },
  },
  async run(context) {
    const format = resolveFormat(context.args.format, context.args.json);
    const withValues = resolveWithList(context.args.with);
    const failOn = resolveFailOn(context.args.failOn);
    const result = collectProjectStatus(String(context.args.path ?? "."), {
      includeModules: withValues.includes("modules"),
    });

    if (format === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatStatusText(result)}\n`);
    }

    process.exitCode = shouldFail(result, failOn) ? 1 : 0;
  },
});

if (import.meta.main) {
  await runMain(statusCommand as CommandDef);
}
