import { useState } from 'react';
import { api } from '../api.js';

export default function Login({ onLogin }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.post('/auth/login', form);
      onLogin();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center-page">
      <form className="card login" onSubmit={submit}>
        <h1>Pruett POS</h1>
        <p className="muted">Pruett Home Improvement Supply</p>
        <label>Username<input autoFocus autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label>Password or PIN<input type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        {err && <p className="error">{err}</p>}
        <button className="btn primary big" disabled={busy}>Log in</button>
      </form>
    </div>
  );
}
