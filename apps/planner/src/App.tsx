import { Component, useEffect, useState, type ReactNode } from "react";
import { NostrProvider } from "./contexts/NostrContext";
import { SettingsProvider } from "./contexts/SettingsContext";
import { SharingProvider } from "./contexts/SharingContext";
import { CalendarProvider } from "./contexts/CalendarContext";
import { TasksProvider } from "./contexts/TasksContext";
import { LoginScreen } from "./components/LoginScreen";
import { CalendarApp } from "./components/CalendarApp";
import { ReconnectScreen } from "./components/ReconnectScreen";
import { AuthUrlModal } from "./components/AuthUrlModal";
import { useNostr } from "./contexts/NostrContext";
import { initDeepLinks } from "./lib/deepLink";

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
  const [forceLoginScreen, setForceLoginScreen] = useState(false);

  if (!pubkey) {
    // Show the reconnect splash whenever we have a saved pubkey and the
    // ladder is in flight. The ladder retries persistently with backoff
    // (see reconnectBunkerWithBackoff), so transient mobile/PWA tab kills
    // no longer drop the user out to the login screen.
    const showReconnect =
      !forceLoginScreen &&
      hasSavedSession &&
      (autoLoginState === "attempting" || autoLoginState === "reconnecting");

    if (showReconnect) {
      return (
        <ReconnectScreen
          onSwitchAccount={() => { setForceLoginScreen(true); }}
        />
      );
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
  // Register deep-link handlers exactly once for the app's lifetime.
  // Same wiring covers Amber's nostrconnect:// intent on Android, bunker
  // URIs from desktop signers (Tauri), and protocol-handler tabs on
  // browsers that support it. Subscribers attach via onDeepLink.
  useEffect(() => initDeepLinks(), []);
  return (
    <ErrorBoundary>
      <NostrProvider>
        <AppContent />
        <AuthUrlModal />
      </NostrProvider>
    </ErrorBoundary>
  );
}
