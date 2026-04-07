import { defineConfig } from "astro/config";
import svelte from "@astrojs/svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  integrations: [svelte()],
  trailingSlash: "always",
  vite: {
    plugins: [tailwindcss()],
  },
});
