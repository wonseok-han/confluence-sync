export * from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
self.MonacoEnvironment = {getWorker:()=>new Worker('/assets/editor.worker.js',{type:'module'})};
