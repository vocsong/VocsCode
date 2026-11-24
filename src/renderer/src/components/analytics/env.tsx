/**
 * Where the analytics tabs are rendered. The desktop can open a live session and read back the
 * executions behind a reliability signature; the code.vocs.io dashboard renders uploaded
 * snapshots from several computers and can do neither (docs/WEB-DASHBOARD.md §6).
 */
import React, { createContext, useContext } from 'react';
import type { UsageSessionRecord } from '../../../../shared/types';

export interface AnalyticsEnv {
  /** Reliability signatures can load their example executions (`analytics:executions`). */
  drillDown: boolean;
  /** Session rows are matched against the live session list and open on click. */
  liveSessions: boolean;
  /** The computer a session ran on, shown on its row in a multi-computer view. */
  computerOf?: (session: UsageSessionRecord) => string | undefined;
}

const DESKTOP: AnalyticsEnv = { drillDown: true, liveSessions: true };

const Env = createContext<AnalyticsEnv>(DESKTOP);

export function AnalyticsEnvProvider({ value, children }: { value: AnalyticsEnv; children: React.ReactNode }) {
  return <Env.Provider value={value}>{children}</Env.Provider>;
}

export function useAnalyticsEnv(): AnalyticsEnv {
  return useContext(Env);
}
