import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: parseInt(process.env.VITE_DEV_PORT || "8080"),
    allowedHosts: process.env.VITE_ALLOWED_HOSTS?.split(",").filter(Boolean),
    hmr: process.env.VITE_ALLOWED_HOSTS
      ? {
          clientPort: 443,
        }
      : undefined,
  },
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
