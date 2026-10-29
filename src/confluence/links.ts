/** Navigation links emitted by Confluence exports are web paths, not disk paths. */
export function isConfluenceWebPath(value:string):boolean {
 let path=value.split(/[?#]/)[0];
 try{for(let i=0;i<4;i++){const decoded=decodeURIComponent(path);if(decoded===path)break;path=decoded;}}catch{return false;}
 if(/[\\\x00-\x1f\x7f]/.test(path)||path.split('/').some(part=>part==='.'||part==='..'))return false;
 return path==='/wiki'||path.startsWith('/wiki/');
}
