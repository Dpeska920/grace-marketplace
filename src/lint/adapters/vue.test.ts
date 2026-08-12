import { describe, expect, it } from "bun:test";

import { createVueAdapter } from "./vue";

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

  it("populates localSymbols for <script setup> top-level bindings", () => {
    const text = `<template><div>{{ msg }}</div></template>
<script setup lang="ts">
const msg = "hello";
</script>
`;
    const analysis = adapter.analyze("src/Local.vue", text);
    expect(analysis.localSymbols.has("msg")).toBe(true);
  });
});
