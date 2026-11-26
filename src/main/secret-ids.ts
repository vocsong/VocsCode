/**
 * `SecretStore` ids that hold identity material (the relay identity and the retired relay enrollment
 * secret, a kept Vocs sign-in, a Vocs MCP Hub connection). They share the store with provider API keys, so they must never be reachable
 * as a provider id: not written or cleared through `secrets:*`, and never read back as a provider's
 * API key.
 */
export function isReservedSecretId(id: string): boolean {
  return id === 'remote-host' || id === 'remote-enroll' || id.startsWith('vocs-account:') || id.startsWith('vocs-hub:');
}

/** A secret getter for anything keyed by provider (or other user-chosen) ids: reserved ids read as
 *  absent, so a provider named `vocs-account:staging` can never receive the vault record. */
export function providerSecrets(get: (id: string) => Promise<string | undefined>): (id: string) => Promise<string | undefined> {
  return async (id) => (isReservedSecretId(id) ? undefined : get(id));
}
