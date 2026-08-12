import path from "node:path";

import type { LanguageAdapter } from "../types";
import { createDartAdapter } from "./dart";
import { createKotlinAdapter } from "./kotlin";
import { createPythonAdapter } from "./python";
import { createSwiftAdapter } from "./swift";
import { createTypeScriptAdapter } from "./typescript";
import { createVueAdapter } from "./vue";

const adapters: LanguageAdapter[] = [
  createTypeScriptAdapter(),
  createPythonAdapter(),
  createDartAdapter(),
  createKotlinAdapter(),
  createSwiftAdapter(),
  createVueAdapter(),
];

export function getLanguageAdapter(filePath: string) {
  const normalizedPath = path.normalize(filePath);
  return adapters.find((adapter) => adapter.supports(normalizedPath)) ?? null;
}
