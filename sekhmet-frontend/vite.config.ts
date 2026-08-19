import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  nitro: false,
  tanstackStart: {
    spa: {
      enabled: true,
      prerender: { enabled: false },
    },
    server: { entry: "server" },
    base: './',
  },
  vite: {
    build: {
      rollupOptions: {
        external: ["@capacitor-community/sqlite"],
      },
    },
    ssr: {
      external: ["@capacitor-community/sqlite"],
    },
    optimizeDeps: {
      exclude: ["@capacitor-community/sqlite"],
    },
  },
});

