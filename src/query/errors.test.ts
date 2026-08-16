import { describe, expect, it } from "bun:test";

import { assertKnownArgs, GraceCommandError } from "./errors";

describe("assertKnownArgs", () => {
  const lintLikeArgsDef = {
    path: { type: "string", alias: "p", default: "." },
    failOn: { type: "string", default: "errors" },
    assertions: { type: "string", default: "current" },
    runCommands: { type: "boolean", default: false },
  };

  it("accepts every key citty derives for a declared arg: its own name, camelCase, kebab-case, and alias", () => {
    const parsed = {
      _: [],
      path: ".",
      p: ".",
      failOn: "errors",
      "fail-on": "errors",
      assertions: "current",
      runCommands: false,
      "run-commands": false,
    };

    expect(() => assertKnownArgs(lintLikeArgsDef, parsed)).not.toThrow();
  });

  it("rejects a one-letter typo on a long flag instead of silently ignoring it", () => {
    // The real-world case this guards: `--assertion target` (missing the
    // trailing s) used to parse cleanly, leave `assertions` on its default
    // `current`, and never surface the typo — see grace-cli-diagnosis.md §7.
    const parsed = { _: [], path: ".", failOn: "errors", assertion: "target", runCommands: false };

    expect(() => assertKnownArgs(lintLikeArgsDef, parsed)).toThrow(
      expect.objectContaining({ code: "invalid-arguments" }),
    );
  });

  it("rejects a typo'd kebab-case flag the same way", () => {
    const parsed = { _: [], path: ".", failOn: "errors", assertions: "target", "run-command": true };

    expect(() => assertKnownArgs(lintLikeArgsDef, parsed)).toThrow(
      expect.objectContaining({ code: "invalid-arguments" }),
    );
  });

  it("always allows the positional leftover array key", () => {
    const parsed = { _: ["extra-positional"], path: "." };

    expect(() => assertKnownArgs({ path: { type: "string", default: "." } }, parsed)).not.toThrow();
  });

  it("throws a GraceCommandError so the caller's own error envelope formats it", () => {
    const parsed = { _: [], jsonn: true };
    let observed: unknown;

    try {
      assertKnownArgs({ json: { type: "boolean", default: false } }, parsed);
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(GraceCommandError);
    expect((observed as GraceCommandError).code).toBe("invalid-arguments");
  });
});
