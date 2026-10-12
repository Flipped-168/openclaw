import { renderPicker } from "../../components/select-picker.ts";
import { SUPPORTED_LOCALES, t, type Locale } from "../../i18n/index.ts";

export function languageLabel(locale: Locale) {
  const key = locale.replace(/-([a-zA-Z])/g, (_, character) => character.toUpperCase());
  return t(`languages.${key}`);
}

export function renderLanguageSelect(
  locale: Locale | undefined,
  resolvedLocale: Locale,
  onChange: (locale: Locale | undefined) => void,
) {
  const systemLabel = `${t("common.system")} (${languageLabel(resolvedLocale)})`;
  return renderPicker({
    label: t("quickSettings.language"),
    value: locale ?? "system",
    options: [
      { value: "system", label: systemLabel },
      ...SUPPORTED_LOCALES.map((value) => ({ value, label: languageLabel(value) })),
    ],
    onChange: (value) => onChange(SUPPORTED_LOCALES.find((locale) => locale === value)),
  });
}
