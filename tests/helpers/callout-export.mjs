import {createDocument} from '@mixmark-io/domino';
/** Synthetic export_view: retain body markup, render panels and invisible anchors. */
export function panelExport(storage) {
 storage=storage.replace(/<ac:structured-macro ac:name="code">([\s\S]*?)<\/ac:structured-macro>/g,(_all,body)=>{
  const code=body.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)?.[1]??'';
  return '<pre>'+code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</pre>';
 });
 storage=storage.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,(_all,text)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
 const doc=createDocument(storage);
 for(const el of Array.from(doc.querySelectorAll('*')).reverse()) {
  if(el.nodeName.toLowerCase()==='ac:link') {
   const a=doc.createElement('a');a.setAttribute('href','#Page'+el.getAttribute('ac:anchor'));a.textContent=el.textContent;el.parentNode.replaceChild(a,el);continue;
  }
  if(el.nodeName.toLowerCase()==='ac:image') {
   const name=el.querySelector('ri\\:attachment')?.getAttribute('ri:filename');if(name){const img=doc.createElement('img');img.src='/download/attachments/123/'+name;el.parentNode.replaceChild(img,el);}continue;
  }
  if(el.nodeName.toLowerCase()!=='ac:structured-macro')continue;
  if(el.getAttribute('ac:name')==='anchor') {
   const anchor=doc.createElement('span');anchor.className='confluence-anchor-link';anchor.id=el.textContent;el.parentNode.replaceChild(anchor,el);
  } else if(el.getAttribute('ac:name')==='panel') {
   const title=Array.from(el.children).find(c=>c.getAttribute('ac:name')==='title')?.textContent??'';
   const body=Array.from(el.children).find(c=>c.nodeName.toLowerCase()==='ac:rich-text-body');
   const panel=doc.createElement('div');panel.className='panel';const header=doc.createElement('div');header.className='panelHeader';header.textContent=title;const content=doc.createElement('div');content.className='panelContent';while(body.firstChild)content.appendChild(body.firstChild);panel.appendChild(header);panel.appendChild(content);el.parentNode.replaceChild(panel,el);
  }
 }
 return doc.body.innerHTML;
}
