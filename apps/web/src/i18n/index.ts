/**
 * i18next setup for the static UI (EN/IT). The chosen language is persisted
 * in localStorage; it defaults to English rather than browser-detected, so a
 * dedicated detector plugin isn't needed — just read the stored value once.
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import it from "./locales/it.json";

export type Lang = "en" | "it";
export const LANG_STORAGE_KEY = "steward-lang";

function initialLanguage(): Lang { return "en"; }

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    it: { translation: it },
  },
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

i18n.on("languageChanged", (lng) => {
  localStorage.setItem(LANG_STORAGE_KEY, lng);
});

export default i18n;
