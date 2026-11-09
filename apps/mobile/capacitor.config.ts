import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "de.diewehmut.selbstlauf",
  appName: "Selbstlauf",
  webDir: "dist",
  loggingBehavior: "none",
  server: { cleartext: true },
  android: { allowMixedContent: true },
  plugins: {
    SystemBars: { insetsHandling: "native", style: "DARK", initialViewportFitValueHint: "cover" },
  },
};

export default config;
