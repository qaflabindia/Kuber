import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [sveltekit()],
  // Never inline assets as data: URIs; the CSP allows fonts and images from 'self' only.
  build: { assetsInlineLimit: 0 }, server: { port: 3000, strictPort: true } });
