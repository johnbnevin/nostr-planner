import { Component, useEffect, useRef, useState, type ReactNode } from "react";
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
  const { pubkey, hasSavedSession, autoLoginState, retryAutoLogin } = useNostr();
  const [forceLoginScreen, setForceLoginScreen] = useState(false);
  // Set to true when the user clicks "Wait longer" — keeps the reconnect
  // screen visible even after the 60-second bunker window expires, and
  // silently restarts the attempt each time it times out.
  const [userWantsToWait, setUserWantsToWait] = useState(false);
  // Bumped each time autoLoginState transitions TO "attempting" (first load
  // or after a retry). Used as ReconnectScreen key so its countdown resets
  // automatically without prop-drilling a "reset" signal.
  const [attemptKey, setAttemptKey] = useState(0);
  const prevStateRef = useRef(autoLoginState);

  useEffect(() => {
    if (autoLoginState === "attempting" && prevStateRef.current !== "attempting") {
      setAttemptKey((k) => k + 1);
    }
    prevStateRef.current = autoLoginState;
  }, [autoLoginState]);

  // When the user asked to wait and the current 60-second attempt expires,
  // silently kick off a new attempt. This keeps the screen alive without
  // the user having to do anything.
  useEffect(() => {
    if (userWantsToWait && autoLoginState === "failed") {
      retryAutoLogin();
    }
  }, [userWantsToWait, autoLoginState, retryAutoLogin]);

  if (!pubkey) {
    const showReconnect =
      !forceLoginScreen &&
      hasSavedSession &&
      (autoLoginState === "attempting" ||
        (userWantsToWait && autoLoginState === "failed"));

    if (showReconnect) {
      return (
        <ReconnectScreen
          key={attemptKey}
          onSwitchAccount={() => { setForceLoginScreen(true); setUserWantsToWait(false); }}
          onWaitLonger={() => setUserWantsToWait(true)}
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
  return (
    <ErrorBoundary>
      <NostrProvider>
        <AppContent />
      </NostrProvider>
    </ErrorBoundary>
  );
}
