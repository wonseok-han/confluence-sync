import {createConfluenceTransport} from '../../web/client/confluence-transport.js';
let override,transport;
export function bindConfluenceTransport(fetch){override=fetch;transport=undefined;}
export function confluenceFetch(input,init){
 if(override)return override(input,init);
 transport??=createConfluenceTransport({fetch:globalThis.fetch.bind(globalThis),origin:globalThis.location.origin});
 return transport(input,init);
}
