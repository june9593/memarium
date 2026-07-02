import { defineConfig } from "astro/config";

// GitHub Pages serves project sites at /<repo>/. Locally we serve at /.
// CI sets MEMARIUM_PAGES_BASE = "/memarium/" and MEMARIUM_PAGES_URL =
// "https://june9593.github.io/memarium/".
export default defineConfig({
  site: process.env.MEMARIUM_PAGES_URL || "http://localhost:4321",
  base: process.env.MEMARIUM_PAGES_BASE || "/",
  output: "static",
  trailingSlash: "always",
});
