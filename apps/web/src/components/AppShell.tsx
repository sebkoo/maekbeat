import { Link } from "react-router";
import type { ReactNode } from "react";

import { RouteErrorBoundary } from "./ErrorBoundary";

const DISCLAIMER_URL = "https://github.com/sebkoo/maekbeat/blob/main/DISCLAIMER.md";

/**
 * The shell every route renders inside. The not-a-medical-device line sits in
 * the header, always visible and not dismissible: labelling includes the
 * interface, so the DISCLAIMER.md policy has to be readable on the screen a
 * caregiver actually looks at, not only in the repository.
 */
export function AppShell(props: { children: ReactNode }) {
  return (
    <div className="mb-app">
      <header className="mb-header">
        <div className="mb-header__bar">
          <div className="mb-brand">
            {/* Not an h1: the page's single h1 belongs to the route. */}
            <p className="mb-brand__name">Maekbeat</p>
            <span className="mb-brand__tagline">caregiver dashboard</span>
          </div>
          <nav className="mb-nav" aria-label="Sections">
            <Link className="mb-nav__link" to="/">
              Devices
            </Link>
          </nav>
        </div>
        <p className="mb-disclaimer">
          Not a medical device. Synthetic data only — no diagnosis, no monitoring of any real
          person.{" "}
          <a className="mb-disclaimer__link" href={DISCLAIMER_URL}>
            Read the disclaimer
          </a>
          .
        </p>
      </header>
      <main className="mb-main">
        <RouteErrorBoundary>{props.children}</RouteErrorBoundary>
      </main>
    </div>
  );
}
