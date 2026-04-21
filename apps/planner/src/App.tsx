import { Component, useState, type ReactNode } from "react";
import { NostrProvider } from "./contexts/NostrContext";
import { SettingsProvider } from "./contexts/SettingsContext";
import { SharingProvider } from "./contexts/SharingContext";
import { CalendarProvider } from "./contexts/CalendarContext";
import { TasksProvider } from "./contexts/TasksContext";
import { LoginScreen } from "./components/LoginScreen";
import { CalendarApp } from "./components/CalendarApp";
import { ReconnectScreen } from "./components/ReconnectScreen";
import { useNostr } from "./contexts/NostrContext";

/**
 * Error boundary that catches unhandled render errors and displays a
 * recovery UI instead of a blank white screen.
 */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[error-boundary] uncaught render error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl shadow-lg max-w-md w-full p-6 text-center">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Something went wrong</h2>
            <p className="text-sm text-gray-500 mb-4">
              {this.state.error?.message || "An unexpected error occurred."}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-primary-600 text-white rounded-xl text-sm font-medium hover:bg-primary-700"
            >
              Reload App
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppContent() {
  const { pubkey, hasSavedSession, autoLoginState } = useNostr();
  // When the user explicitly taps "Use a different login method" on the
  // reconnect screen, we want to show the full LoginScreen until they either
  // log in successfully or the session finishes reconnecting on its own.
  const [forceLoginScreen, setForceLoginScreen] = useState(false);

  if (!pubkey) {
    // Returning user whose auto-login is still running — show the
    // reconnect splash so they don't see the full login screen as if
    // they had been kicked out. If auto-login actually fails, fall
    // straight through to LoginScreen (the "Session paused / try again"
    // state in between was dead UI — retry never recovered, so the
    // user's only real option was "use a different login method",
    // which is what LoginScreen already is).
    const showReconnect =
      !forceLoginScreen &&
      hasSavedSession &&
      autoLoginState === "attempting";
    if (showReconnect) {
      return <ReconnectScreen onSwitchAccount={() => setForceLoginScreen(true)} />;
    }
    return <LoginScreen />;
  }

  return (
    <SettingsProvider>
      <SharingProvider>
        <CalendarProvider>
          <TasksProvider>
            <CalendarApp />
          </TasksProvider>
        </CalendarProvider>
      </SharingProvider>
    </SettingsProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <NostrProvider>
        <AppContent />
      </NostrProvider>
    </ErrorBoundary>
  );
}
