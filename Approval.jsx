// Manager approval: wrap any API call with withApproval(fn). If the server answers
// "needsApproval", a manager signs in on this screen and the call is retried with a one-time token.
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api.js';

const Ctx = createContext(null);
export const useApproval = () => useContext(Ctx);

export function ApprovalProvider({ children }) {
  const [req, setReq] = useState(null);
  const [form, setForm] = useState({ username: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const resolver = useRef(null);

  const ask = useCallback((reason) => new Promise((resolve) => {
    resolver.current = resolve;
    setForm({ username: '', password: '' });
    setErr('');
    setReq({ reason });
  }), []);

  const withApproval = useCallback(async (fn) => {
    try {
      return await fn(null);
    } catch (e) {
      if (!e.data?.needsApproval) throw e;
      const token = await ask(e.message);
      if (!token) throw Object.assign(new Error('Approval canceled'), { canceled: true });
      return fn(token);
    }
  }, [ask]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const { token } = await api.post('/auth/approve', form);
      setReq(null);
      resolver.current?.(token);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => { setReq(null); resolver.current?.(null); };

  return (
    <Ctx.Provider value={{ withApproval, ask }}>
      {children}
      {req && (
        <Modal title="Manager approval" onClose={cancel}>
          <form onSubmit={submit} className="stack">
            <p className="notice warn">{req.reason}</p>
            <label>Manager username<input autoFocus value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
            <label>Password<input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
            {err && <p className="error">{err}</p>}
            <div className="row end">
              <button type="button" className="btn" onClick={cancel}>Cancel</button>
              <button className="btn primary" disabled={busy}>Approve</button>
            </div>
          </form>
        </Modal>
      )}
    </Ctx.Provider>
  );
}
