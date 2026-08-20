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
    server: {
      allowedHosts: true,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:3000",
          changeOrigin: true,
        },
      },
    },
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

