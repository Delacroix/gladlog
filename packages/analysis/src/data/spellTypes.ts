/**
 * Spell tag enum (originally defined in this repository).
 * Older code imported an identically named enum through the parser package;
 * the member names are an interoperability fact of our own utils, so they are
 * declared independently here without referencing any upstream expression.
 */
export enum SpellTag {
  Offensive = "Offensive",
  Defensive = "Defensive",
  Control = "Control",
  External = "External",
}
