import { createContext, useContext } from 'react';

export const SessionContext = createContext({ user: null, store: {}, cardMode: 'simulated', refresh: () => {} });
export const useSession = () => useContext(SessionContext);
export const isManager = (u) => u && (u.role === 'manager' || u.role === 'admin');
