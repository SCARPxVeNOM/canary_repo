import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static build (dist/), servable from any host.
export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },
});
