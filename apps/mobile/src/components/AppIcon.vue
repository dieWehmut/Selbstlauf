<script setup lang="ts">
defineProps<{ name: string }>();
const paths: Record<string, string> = {
  dashboard: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  sessions: "M4 4h16v12H7l-3 4z M8 8h8 M8 12h5",
  agent: "M9 3h6 M12 3v3 M5 6h14v14H5z M9 11h.01 M15 11h.01 M9 16h6 M2 10v6 M22 10v6",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
  computer: "M3 4h18v12H3z M8 21h8 M12 16v5",
  palette: "M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4 2 2 0 0 1 1-4h3a3 3 0 0 0 3-3c0-4-4-7-9-7 M7 9h.01 M10 6h.01 M15 6h.01 M18 9h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M12 11v6 M12 7h.01",
  back: "M19 12H5 M12 5l-7 7 7 7",
  chevron: "M9 5l7 7-7 7",
  refresh: "M20 7a9 9 0 1 0 1 8 M20 3v5h-5",
  send: "M21 3l-7 18-4-7-7-4z M10 14L21 3",
  stop: "M6 6h12v12H6z",
  play: "M8 5l11 7-11 7z",
  pause: "M8 5v14 M16 5v14",
  focus: "M8 3H3v5 M16 3h5v5 M8 21H3v-5 M16 21h5v-5 M8 8l8 8 M16 8l-8 8",
  terminal: "M4 5h16v14H4z M7 9l3 3-3 3 M12 15h5",
  close: "M5 5l14 14 M19 5L5 19",
  trash: "M4 7h16 M9 7V4h6v3 M7 7l1 14h8l1-14 M10 11v6 M14 11v6",
  tool: "M14 6l4-4 4 4-4 4 M18 6 9 15l-4-4 9-9 M4 4l5 5",
};
</script>

<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path :d="paths[name] || paths.info!" />
  </svg>
</template>
