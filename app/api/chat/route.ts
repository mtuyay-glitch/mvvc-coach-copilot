function formatForChat(text: string) {
  return text
    // Remove any leftover citation tags just in case
    .replace(/\s*\[(?:K|M|S)\d+\]\s*/g, " ")

    // Normalize headers
    .replace(/\bFACT:\b/g, "\nFACT:\n")
    .replace(/\bPROJECTION:\b/g, "\nPROJECTION:\n")
    .replace(/\bNext steps\b/gi, "\nNext steps:\n")

    // Ensure section titles break cleanly
    .replace(/FACT\s+—/g, "\nFACT —")
    .replace(/PROJECTION\s+—/g, "\nPROJECTION —")

    // Force bullets onto their own lines
    .replace(/\s-\s/g, "\n- ")

    // Clean up excessive whitespace
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
