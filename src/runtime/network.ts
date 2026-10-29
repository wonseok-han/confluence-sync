/** Network boundary shared by CLI and hosted Node execution. Browser builds bind
 * this boundary to the same-origin Confluence gateway instead of replacing fetch globally.
 */
export const confluenceFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);
