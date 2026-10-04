"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    if (res.ok) {
      router.replace("/");
      router.refresh();
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setError(data.error ?? "Sign-in failed");
    setBusy(false);
  }

  return (
    <main className="login">
      <form onSubmit={submit} className="login-card">
        <div className="brand">
          <Image src="/keenable-logo.svg" alt="Keenable" width={150} height={28} priority />
          <span className="brand-sub">Adverse media check</span>
        </div>
        <label htmlFor="pw">Demo password</label>
        <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
        {error && <p className="form-error">{error}</p>}
        <button className="btn-primary" disabled={busy || !password}>
          {busy ? "Checking…" : "Enter"}
        </button>
      </form>
    </main>
  );
}
