import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  nitro: false,   //  ici, au premier niveau
  tanstackStart: {
    spa: {
      enabled: true,
      prerender: { enabled: false },
    },
    server: { entry: "server" },
  },
});

