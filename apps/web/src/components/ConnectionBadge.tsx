import type { ConnectionState } from "../api/stream";

/**
 * The fan-out socket's state, in the same three-cue discipline as the alert
 * badge (docs/DECISIONS.md #12): the word carries it, the mark and border style
 * repeat it, and colour comes last. `connecting` and `reconnecting` share the
 * caution palette on purpose — both mean "not receiving yet, still trying" —
 * and are told apart by the word.
 */
const TONE: Record<ConnectionState, { tone: "raised" | "ongoing" | "resolved"; label: string }> = {
  connecting: { tone: "ongoing", label: "connecting" },
  live: { tone: "resolved", label: "live" },
  reconnecting: { tone: "ongoing", label: "reconnecting" },
  disconnected: { tone: "raised", label: "disconnected" },
};

export function ConnectionBadge(props: { state: ConnectionState }) {
  const { tone, label } = TONE[props.state];
  return (
    <span
      className="mb-conn-badge"
      data-alert-state={tone}
      data-conn-state={props.state}
      role="status"
    >
      {label}
    </span>
  );
}
