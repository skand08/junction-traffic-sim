import { useEffect, useState, type ReactNode } from "react";
import { api, type AuthState, type AuthUser } from "./api";

/** Shows the sign-in page when the server uses accounts and nobody is signed in; otherwise the app. */
export default function AuthGate({ children }: { children: (user: AuthUser | null, signOut: () => void) => ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    api.me().then(setAuth).catch(() => setOffline(true));
    const out = () => setAuth((a) => (a ? { ...a, user: null } : a));
    window.addEventListener("junction:signed-out", out);
    return () => window.removeEventListener("junction:signed-out", out);
  }, []);

  async function signOut() {
    await api.logout().catch(() => {});
    setAuth((a) => (a ? { ...a, user: null } : a));
  }

  if (offline) return <div className="signin"><div className="signin-card"><p>The server is not answering. Reload the page in a moment.</p></div></div>;
  if (!auth) return null;
  if (auth.enabled && !auth.user) return <SignIn onSignedIn={setAuth} />;
  return <>{children(auth.user, signOut)}</>;
}

function SignIn({ onSignedIn }: { onSignedIn: (a: AuthState) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onSignedIn(await api.login(email.trim(), password)); }
    catch (err: any) { setError(err?.message ?? String(err)); }
    finally { setBusy(false); }
  }

  return (
    <div className="signin">
      <form className="signin-card" onSubmit={submit}>
        <div className="signin-sign"><span className="mark" aria-hidden="true" />Junction</div>
        <h1>Sign in</h1>
        <label className="field block"><span className="label">Email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        <label className="field block"><span className="label">Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="signin-error" role="alert">{error}</p>}
        <button className="primary wide" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="field-hint">No account yet? Ask whoever runs Junction for your team.</p>
      </form>
    </div>
  );
}
