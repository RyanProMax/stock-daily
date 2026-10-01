// A multi-fund filing is not one interchangeable economic exposure. Keep
// selected sentences inside the single, explicitly named risk section.
export function uniqueFundRiskSection(text, name) {
  if (typeof text !== "string" || !name) return null;
  const heading = `${name} Sector Risk:`;
  const at = text.indexOf(heading);
  if (at < 0 || text.indexOf(heading, at + heading.length) >= 0) return null;
  if (at > 0 && text[at - 1] !== "\n") return null;
  const tail = text.slice(at + heading.length);
  const next = /\n[A-Z][^\n:]{1,100} Risk:/u.exec(tail);
  return heading + tail.slice(0, next ? next.index : tail.length);
}
