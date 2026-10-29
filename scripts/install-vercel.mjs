import {spawnSync} from 'node:child_process';
import {npmEnvironment} from './npm-environment.mjs';
const result=spawnSync('npm',['ci'],{env:npmEnvironment(process.env),stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
