import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';

export type PdfPageJob = { file: string; page: number; target: string };

/** npm으로 설치한 렌더러와 글꼴/CMap/WASM 리소스만 사용한다. */
export async function renderPdfPages(jobs: PdfPageJob[], dryRun: boolean): Promise<void> {
  if (!jobs.length) return;
  const { getDocument, VerbosityLevel } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  const files = new Map<string, PdfPageJob[]>();
  for (const job of jobs) {
    const group = files.get(job.file) ?? [];
    group.push(job);
    files.set(job.file, group);
  }
  for (const [file, pages] of files) {
    const task = getDocument({
      data: new Uint8Array(readFileSync(file)),
      cMapUrl: join(root, 'cmaps') + sep,
      cMapPacked: true,
      standardFontDataUrl: join(root, 'standard_fonts') + sep,
      wasmUrl: join(root, 'wasm') + sep,
      useSystemFonts: false,
      verbosity: VerbosityLevel.ERRORS,
    });
    try {
      const pdf = await task.promise;
      for (const { page } of pages) {
        if (page > pdf.numPages) throw new Error(`PDF 쪽 범위 초과: ${page} (총 ${pdf.numPages}쪽)`);
      }
      if (dryRun) continue;
      for (const { page: pageNumber, target } of pages) {
        if (existsSync(target)) continue;
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 160 / 72 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        try {
          await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
          const png = await canvas.encode('png');
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, png);
        } finally {
          page.cleanup();
          canvas.width = canvas.height = 1;
        }
      }
    } catch (error) {
      throw new Error(`PDF 이미지 변환 실패 (${file}): ${(error as Error).message}`);
    } finally {
      await task.destroy();
    }
  }
}
