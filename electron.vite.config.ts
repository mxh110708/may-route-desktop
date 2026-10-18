import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Plugin } from "vite";

import { readApplicationVersion } from "./scripts/version";
import { auditMainLoading, auditRendererLoading } from "./scripts/rendererLoading";

function checkRendererLoading(): Plugin {
  return {
    name: "check-renderer-loading",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(item => item.type === "chunk");
      const result = auditRendererLoading(chunks);
      this.emitFile({ type: "asset", fileName: "renderer-loading.json", source: JSON.stringify(result, null, 2) });
    },
  };
}

function checkMainLoading(): Plugin {
  return {
    name: "check-main-loading",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(item => item.type === "chunk");
      this.emitFile({ type: "asset", fileName: "main-loading.json", source: JSON.stringify(auditMainLoading(chunks), null, 2) });
    },
  };
}

function contentSecurityPolicy(): Plugin {
  let development = false;
  return {
    name: "content-security-policy",
    configResolved(config) {
      development = config.command === "serve";
    },
    transformIndexHtml(html) {
      const inlineScriptSources = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
        ([, body]) => `'sha256-${createHash("sha256").update(body).digest("base64")}'`,
      );
      const scriptSource = development
        ? "'self' 'unsafe-inline'"
        : ["'self'", ...inlineScriptSources].join(" ");
      return [
        {
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: [
              "default-src 'self'",
              `script-src ${scriptSource}`,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "font-src 'self' data:",
              "connect-src 'self' http: https: ws: wss:",
            ].join("; "),
          },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

export default defineConfig({
  main: {
    plugins: [checkMainLoading()],
    define: {
      __APP_VERSION__: JSON.stringify(readApplicationVersion()),
      __CUSTOM_BUILD__: "true",
    },
    resolve: {
      alias: {
        "@dashboard": resolve(import.meta.dirname, "dashboard/src"),
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
        },
      },
    },
  },
  renderer: {
    build: {
      minify: "esbuild",
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/renderer/index.html"),
          tray: resolve(import.meta.dirname, "src/renderer/tray.html"),
        },
      },
    },
    css: {
      modules: {
        localsConvention: "camelCaseOnly",
      },
    },
    resolve: {
      alias: {
        "@dashboard": resolve(import.meta.dirname, "dashboard/src"),
        "@shared": resolve(import.meta.dirname, "src/shared"),
      },
      dedupe: [
        "react",
        "react-dom",
        "@bufbuild/protobuf",
        "@connectrpc/connect",
        "@connectrpc/connect-web",
      ],
    },
    plugins: [react(), contentSecurityPolicy(), checkRendererLoading()],
  },
});
