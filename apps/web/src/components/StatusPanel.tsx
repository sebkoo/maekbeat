import { ApiError } from "../api/http";

/*
 * Loading, empty, error, and disconnected are designed states, not fallbacks.
 * A monitoring surface that cannot say "no data yet" or "connection lost"
 * honestly is worse than none: silence reads as calm, and calm is exactly the
 * wrong answer when the pipe is down.
 */

export type StatusVariant = "loading" | "empty" | "error" | "disconnected";

export interface StatusPanelProps {
  variant: StatusVariant;
  title: string;
  detail: string;
  /** 1 when the panel is the whole page, so every route keeps exactly one h1. */
  headingLevel?: 1 | 2;
  onRetry?: () => void;
}

export function StatusPanel(props: StatusPanelProps) {
  const isFailure = props.variant === "error" || props.variant === "disconnected";
  const Heading = props.headingLevel === 1 ? "h1" : "h2";
  return (
    <section
      className={`mb-state mb-state--${props.variant}`}
      role={isFailure ? "alert" : "status"}
      aria-busy={props.variant === "loading"}
    >
      <Heading className="mb-state__title">{props.title}</Heading>
      <p className="mb-state__detail">{props.detail}</p>
      {props.onRetry ? (
        <button type="button" className="mb-button" onClick={props.onRetry}>
          Try again
        </button>
      ) : null}
    </section>
  );
}

/**
 * Renders a failed read as the state it actually is. An unreachable server is
 * a disconnection, not a bug in the request — the dashboard says so instead of
 * showing an empty chart frame. Device-level staleness (a connected server
 * whose device has gone quiet, `lastReceivedAtMs`) is a different signal and
 * lands with the live stream at C11, per docs/ARCHITECTURE.md.
 */
export function ReadFailure(props: { error: Error; onRetry: () => void; headingLevel?: 1 | 2 }) {
  const disconnected = props.error instanceof ApiError && props.error.kind === "network";
  return (
    <StatusPanel
      variant={disconnected ? "disconnected" : "error"}
      headingLevel={props.headingLevel ?? 2}
      title={disconnected ? "Connection lost" : "This read failed"}
      detail={props.error.message}
      onRetry={props.onRetry}
    />
  );
}
