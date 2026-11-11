// Keep the asset-glob type independent of Vitest's nested Vite/HMR version.
interface ImportMeta {
  glob: import('vite/types/importGlob.d.ts').ImportGlobFunction;
}
