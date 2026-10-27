import type { ActionTextLanguage } from "./types.ts";

export function actionTextLanguagePrompt(language: ActionTextLanguage): string {
  if (language === "default") return "";
  const name = language === "it" ? "Italian" : "English";
  return [
    `Action display language: ${name}.`,
    `Write user-facing Action text in ${name}: Action title/summary, proposal labels/summaries, step labels, manual-link labels, and any updated Action summary.`,
    "This preference affects display text only. Do not translate or otherwise alter executable tool inputs (including email subject/body and calendar event summary/description), reply drafts, source facts, identifiers, proper nouns, URLs, or quoted text. Reply drafts must keep the language and tone appropriate to the source conversation.",
  ].join(" ");
}

export function normalizeActionTextLanguage(value: unknown): ActionTextLanguage {
  return value === "en" || value === "it" ? value : "default";
}
