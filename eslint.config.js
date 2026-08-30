import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/", "web-ext-artifacts/", "kaita/vendor/"],
  },
  js.configs.recommended,
  {
    files: ["kaita/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    files: ["kaita/background.js", "kaita/content.js"],
    languageOptions: { sourceType: "script" },
  },
  {
    files: ["eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
];
