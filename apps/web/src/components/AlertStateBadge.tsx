import type { AlertState } from "@maekbeat/protocol";

/**
 * The alert lifecycle state, encoded three ways before hue is asked to carry
 * anything: the word itself, a mark glyph, and a border style — all from the
 * alert-state tokens in src/styles/tokens.css. The same three states drive the
 * C12 timeline, which is why the palette is fixed now.
 */
export function AlertStateBadge(props: { state: AlertState }) {
  return (
    <span className="mb-alert-badge" data-alert-state={props.state}>
      {props.state}
    </span>
  );
}
