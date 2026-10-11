import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { installHelloListener } from "./data";

// Listen before React mounts: the console shell posts avg:hello right after the iframe's load event.
installHelloListener();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
