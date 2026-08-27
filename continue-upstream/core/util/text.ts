export const capitalizeFirstLetter = (val: string) => {
  if (val.length === 0) {
    return "";
  }
  return val[0].toUpperCase() + val.slice(1);
};

export function replaceEscapedCharacters(str: string): string {
  return str.replaceAll(/\\(n|t|r|\\|"|')/g, (match, p1) => {
    switch (p1) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      case '"':
        return '"';
      case "'":
        return "'";
      default:
        return match; // NOTE: Handle unexpected escapes better than this.
    }
  });
}

export function escapeForSVG(text: string): string {
  return text
    .replace(/&/g, "&amp;") // must be first
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\n/g, "\\n") // newlines
    .replace(/\t/g, "\\t") // tabs
    .replace(/\r/g, "\\r"); // carriage returns
}

/**
 * Folds accents onto their base letter: "Añadir módulo" -> "Anadir modulo".
 *
 * Lumina's text pipeline was written against `[a-z0-9]`, which treats every
 * accented letter as a separator. In a product whose users write Spanish that
 * shreds ordinary words: "número" tokenised to "num" and "ero", so a memory
 * stored as "número de cuenta" could not be recalled by searching "numero de
 * cuenta" — the same word, typed without the accent.
 */
export function foldDiacritics(str: string): string {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/gu, "");
}

/**
 * A slug that is safe as a directory name and still recognisable as the name it
 * came from. Accents are folded rather than dropped, so "Añadir módulo" becomes
 * "anadir-modulo" instead of "a-adir-m-dulo" — a name the user can actually
 * type back into read_skill.
 *
 * Trailing hyphens are trimmed after the length cap, not before, so a name cut
 * mid-word does not leave one dangling.
 */
export function slugifyName(
  str: string,
  fallback: string,
  maxLength = 60,
): string {
  const slug = foldDiacritics(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .slice(0, maxLength)
    .replace(/^-+|-+$/gu, "");
  return slug || fallback;
}

export function kebabOfStr(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2") // handle camelCase, PascalCase, and numbers followed by uppercase
    .replace(/[\s_]+/g, "-") // replace spaces and underscores with hyphens
    .toLowerCase();
}

export function kebabOfThemeStr(str: string): string {
  return str
    .toLowerCase()
    .replace(/[\s_]+/g, "-") // replace spaces and underscores with hyphens
    .replace(/\(|\)/g, ""); // remove parentheses
}
