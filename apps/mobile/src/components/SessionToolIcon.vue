<script setup lang="ts">
import { ref, watch } from "vue";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{ tool: string }>();
const failed = ref(false);
watch(() => props.tool, () => { failed.value = false; });
// Bundle the same publisher assets as the desktop, rather than maintaining copies.
const sources: Record<string, string> = {
  claude: new URL("../../../web/public/tool-icons/claude.svg", import.meta.url).href,
  codex: new URL("../../../web/public/tool-icons/codex.png", import.meta.url).href,
  dsh: new URL("../../../web/public/tool-icons/dsh.png", import.meta.url).href,
  gemini: new URL("../../../web/public/tool-icons/gemini.png", import.meta.url).href,
  antigravity: new URL("../../../web/public/tool-icons/antigravity.svg", import.meta.url).href,
  cursor: new URL("../../../web/public/tool-icons/cursor.png", import.meta.url).href,
};
</script>

<template>
  <img v-if="sources[tool] && !failed" :src="sources[tool]" alt="" aria-hidden="true" class="session-tool-icon" :class="`session-tool-icon--${tool}`" @error="failed = true" />
  <AppIcon v-else name="tool" />
</template>

<style scoped>
.session-tool-icon { width: 24px; height: 24px; object-fit: contain; }
.session-tool-icon--codex { filter: invert(1); }
</style>
