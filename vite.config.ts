import { defineConfig, type Plugin } from "vite";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "connect-src 'self' https://api.github.com",
  "script-src 'self'",
].join("; ");

// The dev server relies on inline styles and an HMR websocket that this policy would block,
// so the CSP meta tag is injected only into production builds.
function contentSecurityPolicy(): Plugin {
  return {
    name: "numa-pocket:csp",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

export default defineConfig({
  base: "/numa-pocket/",
  plugins: [contentSecurityPolicy()],
});
