import { defineConfig } from 'wxt'

/**
 * One codebase, two MV3 targets — ARCHITECTURE.md §2.
 * Chrome ships chrome.tabCapture; Firefox has no equivalent, so capture.ts
 * feature-detects and falls back to captureVisibleTab. Permissions are
 * declared here once and the runtime code never guesses what it has.
 */
export default defineConfig({
  srcDir: '.',
  outDir: '.output',
  manifestVersion: 3,
  modulesDir: 'wxt',
  entrypointsDir: 'entrypoints',
  publicDir: 'public',

  manifest: ({ browser }) => {
    // Firefox MV3 has no chrome.offscreen, no chrome.tabCapture, and no
    // chrome.sidePanel. Requesting them there produces an install-time warning
    // or a hard rejection, and a judge installing the Firefox build sees a
    // permissions prompt we cannot honour. Request only what the target has.
    const isFirefox = browser === 'firefox'
    return {
      name: 'Veil — private vision agent',
      short_name: 'Veil',
      description: 'Reads your screen, hides anything sensitive on your device, and only sends what is safe.',
      version: '0.1.0',

      permissions: [
        'activeTab',
        'tabs',
        'scripting',
        'storage',
        ...(isFirefox ? [] : ['tabCapture', 'offscreen', 'sidePanel']),
      ],

      host_permissions: ['<all_urls>'],

      ...(isFirefox
        ? {
            background: { type: 'module' as const, scripts: ['background.js'] },
            sidebar_action: { default_panel: 'sidepanel.html', default_title: 'Veil' },
          }
        : {
            background: { type: 'module' as const, service_worker: 'background.js' },
            side_panel: { default_path: 'sidepanel.html' },
            action: { default_title: 'Veil' },
            optional_permissions: ['tabCapture'],
          }),

      web_accessible_resources: [
        {
          resources: ['sidepanel.html', 'offscreen.html'],
          matches: ['<all_urls>'],
        },
      ],

      // The offscreen document is the only context that ever touches raw
      // pixels. A strict CSP here is the enforcement mechanism behind the
      // "raw pixels never reach the network" invariant — connect-src is the
      // extension origin, so this document cannot reach the internet at all.
      // [ARCHITECTURE §6.3]
      content_security_policy: {
        extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self'",
      },
    }
  },

  vite: () => ({
    build: {
      target: 'es2022',
      sourcemap: false,
    },
    worker: {
      format: 'es',
    },
    // Models are fetched from the Hub at runtime, never bundled. Keeping them
    // out of the build is what keeps the extension small and the "downloaded
    // once, ever" budget in §7 honest.
    optimizeDeps: {
      exclude: ['@huggingface/transformers'],
    },
  }),
})
