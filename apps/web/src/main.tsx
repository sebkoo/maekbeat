import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { App } from "./App";
import { createApiClient } from "./api/client";
import { ApiProvider } from "./data/api-context";

import "./styles/tokens.css";
import "./styles/app.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("index.html is missing the #root element");
}

const configured: unknown = import.meta.env.VITE_API_BASE_URL;
const api = createApiClient({
  baseUrl: typeof configured === "string" ? configured : undefined,
});

createRoot(container).render(
  <StrictMode>
    <ApiProvider api={api}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ApiProvider>
  </StrictMode>,
);
