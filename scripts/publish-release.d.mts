import type { ReleaseAsset, ReleaseIdentity } from './release-artifacts.mjs';
export interface GitHubRelease { id: number; tag_name: string; draft: boolean; prerelease: boolean; body: string | null }
export interface GitHubAsset { id: number; name: string; size: number; state: string; digest?: string | null }
export interface ReleaseGitHub {
  resolveTag(tag: string): Promise<string>;
  getRelease(tag: string): Promise<GitHubRelease | null>;
  listAssets(releaseId: number): Promise<GitHubAsset[]>;
  hashAsset(assetId: number): Promise<{ size: number; sha256: string }>;
  editRelease(releaseId: number, patch: { tag_name: string; body?: string; draft?: boolean }): Promise<unknown>;
  deleteAsset(assetId: number): Promise<unknown>;
  uploadAsset(releaseId: number, asset: ReleaseAsset): Promise<unknown>;
}
export function provenanceMarker(identity: ReleaseIdentity): string;
export function createGitHubClient(options: { repository: string; token: string; fetchImpl?: typeof fetch }): ReleaseGitHub;
export function publishRelease(options: ReleaseIdentity & { bundlesDir: string; github: ReleaseGitHub }): Promise<{ status: 'published' | 'unchanged'; assets: number }>;
