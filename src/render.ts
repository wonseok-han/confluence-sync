/**
 * 문서 트리 하나를 storage format 으로 옮기는 렌더러.
 *
 * 링크·섹션 링크는 **트리 전체**를 알아야 풀린다(다른 문서의 제목과 헤딩을 참조하므로),
 * 그래서 문서 하나가 아니라 트리 단위로 만든다.
 *
 * push(sync)와 pull 의 매핑 기록이 **같은 문서에 같은 해시**를 내야 하므로 —
 * 어긋나면 pull 직후 push 가 전부 "변경"으로 보인다 — 두 곳이 이 함수 하나를 함께 쓴다.
 */
import { relative } from 'node:path';
import { toStorage, type Rendered } from './markdown.js';
import {
  buildDocIndex, buildVault, collectAssets, vaultResolver, resolveAnchorTargets, type Doc,
} from './docs.js';

export type TreeRenderer = {
  /** base 상대 경로 → 제목 */
  titles: Record<string, string>;
  /** base 상대 경로 → 문서(제목·본문·frontmatter·헤딩) */
  docs: Record<string, Doc>;
  render: (rel: string, body: string, title: string) => Rendered;
};

export function buildTreeRenderer(baseDir: string, rels: string[]): TreeRenderer {
  const { titles, anchors, docs } = buildDocIndex(rels, baseDir);
  // Obsidian [[wikilink]] 해석용 이름 인덱스
  const vault = buildVault(rels, collectAssets(baseDir).map((f) => relative(baseDir, f)));
  // 누가 어느 헤딩을 가리키는지 먼저 모은다 — 그 헤딩에만 Anchor 매크로를 심는다.
  const anchorTargets = resolveAnchorTargets(docs, vault);

  const render = (rel: string, body: string, title: string) =>
    toStorage(body, rel, titles, baseDir, {
      resolveLink: vaultResolver(rel, vault),
      anchorIndex: anchors,
      title,
      anchorNames: anchorTargets[rel],
      bodySlugs: docs[rel]?.bodySlugs,
    });

  return { titles, docs, render };
}
