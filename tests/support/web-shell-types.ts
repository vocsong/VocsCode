/** The mirror snapshot shape the shell harness returns; identical to shared/mirror's snapshot,
 *  kept here so the support module has no runtime import of the server-side type module. */
import type { TranscriptItem } from '../../src/shared/types';

export interface MirroredSession {
  id: string;
  title: string;
  status: string;
  harness: string;
  updatedAt: number;
  truncated?: boolean;
  items: TranscriptItem[];
}
