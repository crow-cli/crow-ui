/**
 * Monaco Editor Web Worker configuration for Vite.
 *
 * Uses explicit Worker creation with Vite's ?worker import suffix.
 * This eliminates the "Could not create web worker(s)" warning
 * and prevents UI freezes from main-thread fallback.
 */

// Import workers with Vite's ?worker suffix
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const self: any;

self.MonacoEnvironment = {
  getWorker: function (_workerId: string, label: string): Worker {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};
