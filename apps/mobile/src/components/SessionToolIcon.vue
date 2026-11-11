<script setup lang="ts">
import { computed, ref, watch } from "vue";
import AppIcon from "./AppIcon.vue";
import { TOOL_ICON_DARK_FILES, TOOL_ICON_FILES } from "../../../web/src/sidebar/tool-icon-files";

const props = defineProps<{ tool: string }>();
const failed = ref(false);
watch(() => props.tool, () => { failed.value = false; });
// Bundle the same publisher assets as the desktop, rather than maintaining copies.
const bundled = import.meta.glob<string>("../../../web/public/tool-icons/*.{png,svg,ico}", { eager: true, query: "?url", import: "default" });
const sources: Record<string, string> = Object.fromEntries(Object.entries(TOOL_ICON_FILES).map(([tool, file]) => [
  tool, bundled[`../../../web/public/tool-icons/${TOOL_ICON_DARK_FILES[tool] ?? file}`]!,
]));
const source = computed(() => Object.hasOwn(sources, props.tool) ? sources[props.tool] : undefined);
</script>

<template>
  <img v-if="source && !failed" :src="source" alt="" aria-hidden="true" class="session-tool-icon" :class="`session-tool-icon--${tool}`" @error="failed = true" />
  <AppIcon v-else name="tool" />
</template>

<style scoped>
.session-tool-icon { width: 24px; height: 24px; object-fit: contain; }
.session-tool-icon { color-scheme: dark; }
.session-tool-icon--cline { filter: invert(1); }
</style>
