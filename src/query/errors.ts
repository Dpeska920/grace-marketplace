/** Stable user-facing query command error code. */
export type GraceCommandErrorCode = "invalid-project" | "not-found" | "ambiguous-target" | "invalid-arguments";

/** Shape shared by every citty arg definition entry this module cares about. */
type ArgDefLike = { alias?: string | string[]; [key: string]: unknown };

function toAliasArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function kebabCaseArgName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function camelCaseArgName(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/**
 * citty's arg parser runs on node:util.parseArgs with strict:false, which
 * silently accepts flags absent from the declared args instead of rejecting
 * them: `--assertion target` (missing the trailing `s`) parses cleanly, the
 * genuine `assertions` key keeps its default, and the caller never learns the
 * flag it read came from a typo. Recomputes the exact key set citty derives
 * per declared arg (its own name, camelCase/kebab-case spelling, and any
 * explicit alias) so a key on context.args outside that set is provably a
 * typo, not a legitimate alternate spelling.
 */
export function assertKnownArgs(argsDef: Record<string, ArgDefLike>, parsedArgs: Record<string, unknown>): void {
  const known = new Set<string>(["_"]);
  for (const [name, def] of Object.entries(argsDef)) {
    known.add(name);
    known.add(kebabCaseArgName(name));
    known.add(camelCaseArgName(name));
    for (const alias of toAliasArray(def.alias)) {
      known.add(alias);
    }
  }

  for (const key of Object.keys(parsedArgs)) {
    if (!known.has(key)) {
      throw new GraceCommandError("invalid-arguments", `Unknown argument \`--${key}\`. Run with --help to see supported arguments.`);
    }
  }
}

/** Error intentionally safe to render without a stack trace. */
export class GraceCommandError extends Error {
  /** Machine-readable error code. */
  readonly code: GraceCommandErrorCode;
  /** Process exit code used by query commands. */
  readonly exitCode: number;
  /** Optional lint or projection issue codes supporting the failure. */
  readonly issues?: string[];

  /** Creates one renderable command error. */
  constructor(code: GraceCommandErrorCode, message: string, options: { exitCode?: number; issues?: string[] } = {}) {
    super(message);
    this.name = "GraceCommandError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.issues = options.issues;
  }
}

/** JSON output returned for every query-command failure requested in JSON mode. */
export type GraceCommandErrorEnvelope = {
  schemaVersion: "1.0.0";
  ok: false;
  error: {
    code: GraceCommandErrorCode;
    message: string;
    issues?: string[];
  };
};

/** Executes any GRACE command operation with stable text or JSON failures. */
export async function runGraceCommand(
  format: "text" | "json",
  operation: () => void | Promise<void>,
  fallbackMessage: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const commandError = error instanceof GraceCommandError
      ? error
      : new GraceCommandError("invalid-project", fallbackMessage);
    if (format === "json") {
      const envelope: GraceCommandErrorEnvelope = {
        schemaVersion: "1.0.0",
        ok: false,
        error: {
          code: commandError.code,
          message: commandError.message,
          ...(commandError.issues?.length ? { issues: commandError.issues } : {}),
        },
      };
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
    } else {
      process.stderr.write(`${commandError.message}\n`);
    }
    process.exitCode = commandError.exitCode;
  }
}

/** Executes a query command and renders stable text or JSON failures without stack traces. */
export async function runQueryCommand(
  format: "text" | "json",
  operation: () => void | Promise<void>,
): Promise<void> {
  return runGraceCommand(format, operation, "Unable to complete the GRACE query. Run `grace lint --path PROJECT` for actionable diagnostics.");
}
