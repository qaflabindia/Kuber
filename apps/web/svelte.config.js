import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ out: "build" }),
    // Strict Content Security Policy: only our own origin. SvelteKit hashes its inline scripts.
    csp: {
      mode: "auto",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:"],
        "font-src": ["self"],
        "connect-src": ["self"],
        "frame-ancestors": ["none"],
        "form-action": ["self"],
        "base-uri": ["self"],
        "object-src": ["none"],
      },
    },
  },
};
