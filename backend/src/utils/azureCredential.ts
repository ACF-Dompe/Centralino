/**
 * The backend's Azure identity, shared by every SDK client that talks to Azure
 * on the application's behalf (Microsoft Graph directory search, Key Vault).
 *
 * In Azure Container Apps this resolves to the backend's user-assigned managed
 * identity: `DefaultAzureCredential` picks it up through `AZURE_CLIENT_ID`. In
 * local dev it falls back to the developer's `az login`.
 *
 * Created ONCE and reused, for the same reason as the database credential in
 * `db/index.ts`: the SDK caches tokens per credential instance, so a new
 * credential per call would mean a managed-identity round-trip per call.
 * (`db/index.ts` keeps its own instance on purpose — the pool is the one place
 * that must not change behaviour because of an unrelated feature.)
 */
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';

let _credential: TokenCredential | null = null;

export function getAzureCredential(): TokenCredential {
  if (!_credential) {
    _credential = new DefaultAzureCredential();
  }
  return _credential;
}

/** Test hook: drop the cached credential so a mock can be picked up again. */
export function resetAzureCredential(): void {
  _credential = null;
}
