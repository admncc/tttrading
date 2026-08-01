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
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <form onSubmit={submit} className="panel" style={{ width: 320 }}>
        <div className="brand" style={{ padding: "0 0 16px" }}>
          TT<span>Desk</span>
        </div>
        <div className="field">
          <label>Password</label>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <div className="neg" style={{ marginBottom: 12, fontSize: 13 }}>
            {error}
          </div>
        )}
        <button className="primary" type="submit" disabled={busy || !password} style={{ width: "100%" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
