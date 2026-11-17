export interface ReleaseIdentity { tag: string; sha: string; version: string }
export type ReleasePlatform = 'windows' | 'macos' | 'linux';
export interface ReleaseAsset { name: string; file: string; size: number; sha256: string; sha512: string }
export const platforms: ReleasePlatform[];
export function validateIdentity(identity: ReleaseIdentity): void;
export function expectedAssets(version: string, platform?: ReleasePlatform): string[];
export function hashFile(file: string): Promise<Omit<ReleaseAsset, 'name' | 'file'>>;
export function validateBundle(dir: string, identity: ReleaseIdentity, platform: ReleasePlatform): Promise<ReleaseAsset[]>;
export function validateCompleteSet(dir: string, identity: ReleaseIdentity): Promise<ReleaseAsset[]>;
export function stageBundle(options: ReleaseIdentity & { sourceDir: string; bundleDir: string; platform: ReleasePlatform }): Promise<ReleaseAsset[]>;
