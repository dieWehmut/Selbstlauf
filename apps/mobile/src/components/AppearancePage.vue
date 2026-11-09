<script setup lang="ts">
import type { AppearanceTheme } from "../composables/use-appearance";
defineProps<{ theme: string; themes: readonly AppearanceTheme[] }>();
const emit = defineEmits<{ select: [theme: string] }>();
</script>

<template>
  <section class="appearance-page" aria-label="选择主题">
    <button v-for="option in themes" :key="option.id" class="theme-option" type="button" :aria-pressed="theme === option.id" @click="emit('select', option.id)">
      <span class="theme-swatches" aria-hidden="true">
        <span v-for="(color, index) in option.swatches" :key="index" class="theme-swatch" :style="{ backgroundColor: color }" />
      </span>
      <span class="theme-name">{{ option.name }}</span>
      <svg v-if="theme === option.id" class="theme-check" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m5 12 4.5 4.5L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </section>
</template>

<style scoped>
.appearance-page { display: grid; gap: 12px; }
.theme-option { display: flex; align-items: center; gap: 18px; width: 100%; min-height: 64px; padding: 16px 20px; border-radius: 999px; background: var(--surface); color: var(--text); text-align: left; }
.theme-option[aria-pressed="true"] { background: color-mix(in srgb, var(--raised) 88%, var(--primary)); }
.theme-option:active { background: var(--raised); }
.theme-swatches { display: flex; flex-shrink: 0; gap: 7px; }
.theme-swatch { width: 28px; height: 28px; border-radius: 50%; }
.theme-name { flex: 1; min-width: 0; font-size: 17px; font-weight: 650; line-height: 1.3; }
.theme-check { width: 24px; height: 24px; color: var(--primary); }
@media (max-width: 359px) {
  .theme-option { gap: 14px; padding-inline: 16px; }
  .theme-swatch { width: 24px; height: 24px; }
}
</style>
