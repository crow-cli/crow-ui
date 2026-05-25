/**
 * Register additional languages with Monaco that aren't built-in.
 *
 * Jinja2: Re-exports Monaco's built-in Twig tokenizer (nearly identical syntax).
 */

import * as monaco from "monaco-editor";

// Monaco's basic-languages are JS files without type declarations
// @ts-ignore
import { conf, language } from "monaco-editor/esm/vs/basic-languages/twig/twig.js";

export function registerMonacoLanguages(): void {
  monaco.languages.register({
    id: "jinja2",
    extensions: [".jinja2", ".jinja"],
    aliases: ["Jinja2", "jinja2", "Jinja", "jinja"],
    mimetypes: ["text/x-jinja2"],
  });
  monaco.languages.setMonarchTokensProvider("jinja2", language);
  monaco.languages.setLanguageConfiguration("jinja2", conf);
}
