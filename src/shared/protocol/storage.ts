// The provider storage service: offers, assignments and retrieval tasks. Browser-safe.
// ---------------------------------------------------------------------------
// Provider storage service: client nodes store data for a provider and earn credits.

export interface StorageRewards {
  /** Paid when the assignment is accepted and the submitted endpoint is live. */
  upfront: number;
  /** Paid each time the provider retrieves a chunk from the client. */
  perRetrieval: number;
  /** Paid at the end of the term if the holder is still holding the data. */
  completion: number;
}

export interface StorageOffer {
  id: string;
  cid?: string;
  title?: string;
  chunks: number;
  bytes: number;
  durationSeconds: number;
  rewards: StorageRewards;
  slots: number;
  requireIdentity: boolean;
}

export type AssignmentStatus = 'downloading' | 'active' | 'completed' | 'failed' | 'released' | 'removed';

export interface StorageAssignment {
  id: string;
  jobId: string;
  /** What the job stores — its content id and title (undefined for nameless jobs). */
  cid?: string;
  title?: string;
  chunkIds: string[];
  bytes: number;
  status: AssignmentStatus;
  acceptedAt: string;
  expiresAt: string;
  retrievals: number;
  earned: number;
  /** The URL backups this account offers for the job's content (provider's records). */
  links?: { id: string; url?: string; baseUrl?: string; status: string }[];
  /** What the client itself keeps on disk for this assignment (filled in client-side). */
  local?: { files: number; chunks: number; bytes: number; complete: boolean };
}

export interface StorageTask {
  id: string;
  type: 'retrieve';
  assignmentId: string;
  chunkId: string;
  deadline: string;
}
