/** App-owned capacity leases. A lease includes tools/approval waits, not just model time. */
export interface MissionCapacity {
  maxConcurrentAgentTurnsGlobal: number;
  maxConcurrentHeavyChecksGlobal: number;
  maxConcurrentWorkersPerMission: number;
  accountLimits?: Record<string, number>;
}

export interface AdmissionRequest {
  missionId: string;
  ownerId: string;
  kind: 'lead' | 'worker' | 'heavy_check';
  accountId?: string;
  /** Lower is more urgent. FIFO within a priority. */
  priority?: number;
  signal?: AbortSignal;
}

export interface CapacityLease {
  ownerId: string;
  admittedAt: number;
  /** Caller must observe turn AND tool quiescence. Idle text alone is not a release condition. */
  release(quiescent: true): void;
}

interface Waiting {
  request: AdmissionRequest;
  sequence: number;
  resolve: (lease: CapacityLease) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export class MissionScheduler {
  private readonly missions = new Map<string, { paused: boolean; workerLimit: number }>();
  private readonly active = new Map<string, AdmissionRequest>();
  private readonly waiting: Waiting[] = [];
  private sequence = 0;

  constructor(private capacity: MissionCapacity) {
    this.validate(capacity);
  }

  private validate(value: MissionCapacity): void {
    for (const n of [value.maxConcurrentAgentTurnsGlobal, value.maxConcurrentHeavyChecksGlobal, value.maxConcurrentWorkersPerMission, ...Object.values(value.accountLimits ?? {})]) {
      if (!Number.isInteger(n) || n < 1 || n > 128) throw new Error('Mission capacity must be an integer between 1 and 128');
    }
  }

  /** Existing calls keep their leases; a lower ceiling only affects new admissions. */
  configure(value: MissionCapacity): void {
    this.validate(value);
    this.capacity = structuredClone(value);
    this.pump();
  }

  /** Each admitted Mission reserves one global turn opportunity for its lead. */
  register(missionId: string, workerLimit = this.capacity.maxConcurrentWorkersPerMission): boolean {
    if (this.missions.has(missionId)) return true;
    if (this.missions.size >= this.capacity.maxConcurrentAgentTurnsGlobal) return false;
    if (!Number.isInteger(workerLimit) || workerLimit < 1 || workerLimit > 32) throw new Error('Invalid Mission worker limit');
    this.missions.set(missionId, { paused: false, workerLimit });
    this.pump();
    return true;
  }

  pause(missionId: string): void {
    const mission = this.missions.get(missionId);
    if (mission) mission.paused = true;
    this.rejectPending(missionId, 'Mission admission paused');
  }

  resume(missionId: string): void {
    const mission = this.missions.get(missionId);
    if (!mission) throw new Error('Mission has no reserved lead capacity');
    mission.paused = false;
    this.pump();
  }

  unregister(missionId: string): void {
    this.pause(missionId);
    if ([...this.active.values()].some((r) => r.missionId === missionId)) throw new Error('Mission still owns non-quiescent capacity');
    this.missions.delete(missionId);
    this.pump();
  }

  /** Recovery is accounting for an already-owned lead, not authorizing another dispatch.
   * It may exceed newly lowered ceilings; all new admissions then wait for positive teardown. */
  retainUnknownLead(request: Omit<AdmissionRequest, 'kind' | 'signal' | 'priority'>, workerLimit = this.capacity.maxConcurrentWorkersPerMission): CapacityLease {
    if (!Number.isInteger(workerLimit) || workerLimit < 1 || workerLimit > 32) throw new Error('Invalid Mission worker limit');
    if (this.active.has(request.ownerId) || this.waiting.some((entry) => entry.request.ownerId === request.ownerId)) throw new Error('Owner already has an active or queued admission');
    this.missions.set(request.missionId, { paused: true, workerLimit });
    this.pause(request.missionId);
    this.active.set(request.ownerId, { ...request, kind: 'lead' });
    let released = false;
    return { ownerId: request.ownerId, admittedAt: Date.now(), release: (quiescent) => {
      if (quiescent !== true) throw new Error('Cannot release capacity before owned activity is quiescent');
      if (released) return;
      released = true; this.active.delete(request.ownerId); this.pump();
    } };
  }

  acquire(request: AdmissionRequest): Promise<CapacityLease> {
    const mission = this.missions.get(request.missionId);
    if (!mission || mission.paused) return Promise.reject(new Error('Mission is not admitting work'));
    if (request.signal?.aborted) return Promise.reject(new Error('Admission canceled'));
    if (this.active.has(request.ownerId) || this.waiting.some((w) => w.request.ownerId === request.ownerId)) return Promise.reject(new Error('Owner already has an active or queued admission'));
    return new Promise((resolve, reject) => {
      const waiting: Waiting = { request: { ...request }, sequence: ++this.sequence, resolve, reject, cleanup: () => undefined };
      const abort = () => {
        const index = this.waiting.indexOf(waiting);
        if (index < 0) return; // A running turn must be explicitly interrupted and reconciled.
        this.waiting.splice(index, 1);
        waiting.cleanup();
        reject(new Error('Admission canceled'));
      };
      request.signal?.addEventListener('abort', abort, { once: true });
      waiting.cleanup = () => request.signal?.removeEventListener('abort', abort);
      this.waiting.push(waiting);
      this.pump();
    });
  }

  private canAdmit(request: AdmissionRequest): boolean {
    if (this.missions.get(request.missionId)?.paused !== false) return false;
    const active = [...this.active.values()];
    if (request.kind === 'heavy_check') return active.filter((r) => r.kind === 'heavy_check').length < this.capacity.maxConcurrentHeavyChecksGlobal;
    const turns = active.filter((r) => r.kind !== 'heavy_check');
    if (turns.length >= this.capacity.maxConcurrentAgentTurnsGlobal) return false;
    if (request.accountId) {
      const limits = this.capacity.accountLimits;
      const limit = limits && Object.hasOwn(limits, request.accountId) ? limits[request.accountId] : undefined;
      if (limit !== undefined && turns.filter((r) => r.accountId === request.accountId).length >= limit) return false;
    }
    if (request.kind === 'lead') return !turns.some((r) => r.missionId === request.missionId && r.kind === 'lead');
    const workers = turns.filter((r) => r.kind === 'worker');
    const mission = this.missions.get(request.missionId)!;
    if (workers.filter((r) => r.missionId === request.missionId).length >= mission.workerLimit) return false;
    // Reserved lead slots cannot be consumed by a worker waiting for that very lead to decide.
    return workers.length < Math.max(0, this.capacity.maxConcurrentAgentTurnsGlobal - this.missions.size);
  }

  private pump(): void {
    this.waiting.sort((a, b) => (a.request.priority ?? (a.request.kind === 'lead' ? 0 : 10)) - (b.request.priority ?? (b.request.kind === 'lead' ? 0 : 10)) || a.sequence - b.sequence);
    for (let i = 0; i < this.waiting.length;) {
      const waiting = this.waiting[i];
      if (!this.canAdmit(waiting.request)) { i++; continue; }
      this.waiting.splice(i, 1);
      waiting.cleanup();
      const request = waiting.request;
      this.active.set(request.ownerId, request);
      let released = false;
      waiting.resolve({
        ownerId: request.ownerId,
        admittedAt: Date.now(),
        release: (quiescent) => {
          if (quiescent !== true) throw new Error('Cannot release capacity before owned activity is quiescent');
          if (released) return;
          released = true;
          this.active.delete(request.ownerId);
          this.pump();
        },
      });
    }
  }

  private rejectPending(missionId: string, reason: string): void {
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const waiting = this.waiting[i];
      if (waiting.request.missionId !== missionId) continue;
      this.waiting.splice(i, 1);
      waiting.cleanup();
      waiting.reject(new Error(reason));
    }
  }

  snapshot(): { active: AdmissionRequest[]; queued: AdmissionRequest[]; missions: string[] } {
    const safe = ({ signal: _signal, ...r }: AdmissionRequest) => ({ ...r });
    return { active: [...this.active.values()].map(safe), queued: this.waiting.map((w) => safe(w.request)), missions: [...this.missions.keys()] };
  }
}
