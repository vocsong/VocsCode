/** Shared session context passed into intelligence service and passive learning hooks. */

/** The session a call is made for. Always built by the app from its own session record. */
export interface IntelligenceContext {
  sessionId: string;
  projectRoot: string;
  cwd: string;
  branch?: string;
  /** App-issued for restricted sessions: no collection, personal or transcript access. */
  restricted?: boolean;
  /** Set only by the host tool gateway; passive excerpts have a stricter policy than desktop reads. */
  modelFacing?: boolean;
  /** Revoked on disconnect or grant/scope change. App-controlled, not a tool argument. */
  signal?: AbortSignal;
}
