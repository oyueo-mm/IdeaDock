// Per browser/account; no authentication material is stored here.
const handlers = new Map<string, () => Promise<void>>();
export function registerFolderWrites(
  account: string,
  flush: () => Promise<void>,
) {
  handlers.set(account, flush);
  return () => {
    if (handlers.get(account) === flush) handlers.delete(account);
  };
}
export async function waitForFolderWrites(account: string) {
  await handlers.get(account)?.();
}
