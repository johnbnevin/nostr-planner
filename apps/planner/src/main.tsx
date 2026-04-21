import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Swallow the benign "WebSocket is already in CLOSING or CLOSED state"
// noise that nostr-tools' SimplePool produces whenever we close and
// reopen a subscription (e.g. tab-visibility changes to dodge stale
// backgrounded sockets). The WebSocket API silently drops the send
// either way; the warning is just clutter in the console.
const __origWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && first.includes("already in CLOSING or CLOSED state")) return;
  __origWarn(...args);
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
