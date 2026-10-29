import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';
export function createHash(algorithm){if(algorithm!=='sha256')throw Error(`Unsupported browser hash: ${algorithm}`);const state=sha256.create();return {update(value){state.update(typeof value==='string'?new TextEncoder().encode(value):value);return this;},digest(encoding){const bytes=Buffer.from(state.digest());return encoding?bytes.toString(encoding):bytes;}};}
export const randomUUID=()=>crypto.randomUUID();
export const randomBytes=size=>Buffer.from(crypto.getRandomValues(new Uint8Array(size)));
export default {createHash,randomUUID,randomBytes};
