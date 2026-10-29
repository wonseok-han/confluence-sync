// Existing push mechanics tests select the workspace explicitly; staging has dedicated tests.
import { positionalArgs } from '../../dist/cli/args.js';
import { loadWorkspace } from '../../dist/sync/workspace.js';
export function explicitPush(args, command = false) {
 const base = args[args.indexOf('--base') + 1];
 const positional = positionalArgs(args);
 if (positional.length > (command ? 1 : 0)) return args;
 const scope = loadWorkspace(base)?.version === 2 ? {path:'.'} : undefined;
 return scope ? [...args, scope.path] : args;
}
