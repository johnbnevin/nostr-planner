import React, { Component, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "500px", margin: "4rem auto" }}>
          <h1 style={{ fontSize: "1.25rem", marginBottom: "1rem" }}>Something went wrong</h1>
          <p style={{ color: "#666", marginBottom: "1rem", fontSize: "0.875rem" }}>
            {this.state.error.message}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: "0.5rem 1rem", borderRadius: "0.5rem", border: "1px solid #ddd", cursor: "pointer", background: "#f5f5f5" }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
