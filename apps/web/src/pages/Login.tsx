import { useState } from "react";
import { api, setToken } from "../api.js";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(password);
      if (res.token) {
        setToken(res.token);
        onSuccess();
      } else {
        onSuccess(); // auth disabled server-side
      }
    } catch {
      setError("Invalid password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form onSubmit={submit} className="login-card">
        <div className="brand">
          <span className="mark">TT</span>
          <span>
            <div className="word">TT Desk</div>
            <div className="sub">Operator cockpit</div>
          </span>
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Sign in</div>
          <div className="small muted">One operator · one password · bearer token stored locally</div>
        </div>
        <div className="field">
          <label>Operator password</label>
          <input
            className="input"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••••"
          />
        </div>
        {error && <div className="loss small">{error}</div>}
        <button className="btn primary lg block" type="submit" disabled={busy || !password}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
          {busy ? "Signing in…" : "Enter the desk"}
        </button>
      </form>
    </div>
  );
}
