/** npm ignores this obsolete injected option; remove it before npm starts so it
 * cannot emit Unknown env config. Preserve all supported cache configuration.
 */
export function npmEnvironment(source){return Object.fromEntries(Object.entries(source).filter(([key])=>key.toLowerCase()!=='npm_config_cache_dir'));}
