/**
 * Confluence Cloud API 클라이언트. createClient(config, opts) 로 생성하면
 * baseUrl·인증·force/verify 옵션을 클로저로 묶은 메서드 집합을 돌려준다.
 */
import { readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import { confluenceFetch as fetch } from '../runtime/network.js';
import type { Mapping } from '../sync/mapping.js';
import { red, yellow, dim } from '../shared/colors.js';

export type ConfluenceConfig = { baseUrl: string; email: string; token: string };
export type ClientOpts = { force: boolean; verify: boolean; requestTimeoutMs?: number; scope?: { id: string; spaceId: string; spaceOnly?: boolean } };
export type UpsertResult = 'created' | 'updated' | 'skipped' | 'moved';
export type ImageRef = { filename: string; abs: string };
/** getNode 결과: 본문(HTML/storage) + 출처 메타(frontmatter 용). */
export type ContentNode = {
  id: string;
  type: string;
  title: string;
  html: string;
  storage: string;
  url?: string;
  updated?: string;
  version?: number;
};

class ConfluenceApiError extends Error {
  constructor(readonly status: number, path: string, readonly responseBody: string, statusText: string) {
    super(`Confluence API ${status} ${statusText}\n${path}\n${responseBody}`);
  }
}

/** Distinguishes missing binary content from authorization and transport failures. */
export class ConfluenceDownloadError extends Error {
  constructor(readonly status: number, statusText: string, path: string) { super(`download ${status} ${statusText}\n${path}`); }
}

export function createClient(cfg: ConfluenceConfig, opts: ClientOpts) {
  const authHeader = () => 'Basic ' + Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64');

  async function api(path: string, init?: RequestInit, onHeaders?: (headers: Headers) => void): Promise<any> {
    const signal = opts.requestTimeoutMs ? AbortSignal.timeout(opts.requestTimeoutMs) : undefined;
    try {
      const res = await fetch(`${cfg.baseUrl}${path}`, {
        ...init, ...(signal ? { signal } : {}),
        headers: {
          Authorization: authHeader(), 'Content-Type': 'application/json', Accept: 'application/json', ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) throw new ConfluenceApiError(res.status, path, await res.text(), res.statusText);
      onHeaders?.(res.headers);
      return res.status === 204 ? null : await res.json();
    } catch (error) {
      if (signal?.aborted) throw new Error(`Confluence 메타데이터 응답 대기 시간이 초과되었습니다 (${opts.requestTimeoutMs! / 1000}초). 잠시 후 다시 시도하세요. 요청: ${path}`);
      throw error;
    }
  }

  /** 페이지 조회. 삭제(휴지통)·부재면 404 → null 반환(그 외 오류는 throw) */
  async function getPageOrNull(pageId: string, withBody = false): Promise<any | null> {
    const res = await fetch(`${cfg.baseUrl}/api/v2/pages/${pageId}${withBody ? '?body-format=storage' : ''}`, {
      headers: { Authorization: authHeader(), Accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Confluence API ${res.status} ${res.statusText}\n/api/v2/pages/${pageId}\n${await res.text()}`);
    return res.json();
  }

  async function getSpaceId(key: string): Promise<string> {
    return (await getSpaceInfo(key)).id;
  }

  /** 스페이스 id + 홈페이지 id(=콘텐츠 트리 루트). */
  async function getSpaceInfo(key: string): Promise<{ id: string; homepageId?: string }> {
    const data = await api(`/api/v2/spaces?keys=${encodeURIComponent(key)}`);
    const space = data.results?.[0];
    if (!space) throw new Error(`Space key '${key}' 를 찾을 수 없습니다.`);
    return { id: String(space.id), homepageId: space.homepageId ? String(space.homepageId) : undefined };
  }

  /** 페이지의 기존 첨부 중 같은 파일명의 attachmentId 를 찾는다(없으면 null). */
  async function findAttachmentId(pageId: string, filename: string): Promise<string | null> {
    const data = await api(
      `/rest/api/content/${pageId}/child/attachment?filename=${encodeURIComponent(filename)}`,
    );
    return data?.results?.[0]?.id ?? null;
  }

  /**
   * 로컬 파일을 페이지 첨부로 업로드(v1, multipart).
   * 같은 파일명 첨부가 이미 있으면 데이터만 새 버전으로 갱신(중복 생성 400 방지),
   * 없으면 신규 생성한다.
   */
  async function uploadAttachment(pageId: string, filename: string, abs: string): Promise<void> {
    const buf = readFileSync(abs);
    // 롤백 오류에만 재시도한다. 매번 첨부를 재조회해 생성/갱신 경로를 다시 결정한다.
    for (let attempt = 0; attempt < 3; attempt++) {
      const attId = await findAttachmentId(pageId, filename);
      await assertInScope(pageId);
      const path = attId
        ? `/rest/api/content/${pageId}/child/attachment/${attId}/data`
        : `/rest/api/content/${pageId}/child/attachment`;
      const form = new FormData();
      form.append('file', new Blob([buf]), filename);
      form.append('minorEdit', 'true');
      const res = await fetch(`${cfg.baseUrl}${path}`, {
        method: 'POST',
        headers: { Authorization: authHeader(), 'X-Atlassian-Token': 'nocheck' },
        body: form,
      });
      if (res.ok) return;
      const detail = await res.text();
      if (res.status === 500 && /UnexpectedRollbackException|rollback-only/i.test(detail) && attempt < 2) {
        console.error(yellow(`    ↻ 첨부 트랜잭션 롤백, 재시도 ${attempt + 1}/2: ${filename}`));
        await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      const traceId = res.headers.get('atl-traceid') ?? res.headers.get('x-arequestid');
      throw new Error(`attachment ${res.status} ${res.statusText}\nPOST ${path}${traceId ? `\ntraceId: ${traceId}` : ''}\n${detail}`);
    }
  }

  /** 페이지의 로컬 첨부를 업로드. 성공 개수 반환. */
  async function uploadAttachments(pageId: string, attachments: ImageRef[], baseDir: string): Promise<number> {
    let ok = 0;
    for (const file of attachments) {
      if (!existsSync(file.abs)) { console.error(yellow(`    ⚠ 첨부 없음: ${relative(baseDir, file.abs)}`)); continue; }
      try { await uploadAttachment(pageId, file.filename, file.abs); ok++; }
      catch (e) { console.error(red(`    ✗ 첨부 업로드 실패 ${file.filename}`) + `\n${(e as Error).message}`); }
    }
    return ok;
  }

  const uploadImages = uploadAttachments;

  /** Expanded metadata only: scope selection never downloads page bodies. */
  async function getContentInfo(id: string): Promise<{ id: string; title: string; type: 'page' | 'folder'; spaceId: string; parentId?: string; ancestors: { id: string; title: string }[] }> {
    const data = await getV1(`/rest/api/content/${encodeURIComponent(id)}?expand=ancestors,space,version`);
    if (String(data.id) !== id || !['page', 'folder'].includes(data.type) || !data.space?.id || !Array.isArray(data.ancestors)) throw new Error(`콘텐츠 위치를 확인할 수 없습니다: ${id}`);
    const parentId = data.parentId ?? data.ancestors.at(-1)?.id;
    return { id: String(data.id), title: data.title, type: data.type, spaceId: String(data.space.id), ...(parentId ? {parentId: String(parentId)} : {}), ancestors: data.ancestors.map((a: any) => ({ id: String(a.id), title: a.title })) };
  }
  async function assertInScope(id: string) {
    if (!opts.scope) return;
    const info = await getContentInfo(id);
    if (info.spaceId !== opts.scope.spaceId || (!opts.scope.spaceOnly && info.id !== opts.scope.id && !info.ancestors.some(a => a.id === opts.scope!.id))) throw new Error(`선택한 원격 스코프 밖입니다: #${id}`);
    return info;
  }

  /** Read-only preflight. An unknown baseline must never authorize overwriting an existing page. */
  async function checkPage(mapping: Mapping, spaceId: string, key: string, hash: string, forceUpdate = false): Promise<void> {
    const entry = mapping[key];
    if (!entry?.pageId) return;
    const changed = entry.hash !== hash || opts.force || forceUpdate;
    if (!changed && !opts.verify && !entry.pendingMove && !opts.scope) return;
    await assertInScope(entry.pageId);
    const current = await getPageOrNull(entry.pageId);
    assertPageBaseline(entry, current, spaceId, key, changed || !!entry.pendingMove);
  }

  function assertPageBaseline(entry: Mapping[string], current: any, spaceId: string, key: string, writes: boolean): void {
    if (!current) throw new Error(`원격 페이지 #${entry.pageId}가 없습니다: ${key}. 자동 재생성하지 않습니다.`);
    if (current.spaceId !== undefined && String(current.spaceId) !== spaceId) throw new Error(`페이지 스페이스가 다릅니다: ${key}`);
    if (writes && entry.remoteParentId && typeof current.parentId === 'string' && current.parentId !== entry.remoteParentId) throw new Error(`원격 위치 충돌: ${key} (기준 부모 #${entry.remoteParentId}, 현재 #${current.parentId}) — pull로 원격 위치를 확인하세요.`);
    if (entry.remoteVersion === undefined) {
      if (writes) throw new Error(`원격 버전 기준이 없습니다: ${key}. 로컬 변경을 보관한 뒤 pull로 기준을 확보하세요.`);
      return;
    }
    if (current.version?.number !== entry.remoteVersion) throw new Error(`원격 변경 충돌: ${key} (기준 v${entry.remoteVersion}, 현재 v${current.version?.number ?? '?'}) — pull로 원격 내용을 확인하세요.`);
  }

  /** Incremental push with remote-version protection; --force does not bypass conflicts. */
  async function upsertPage(
    mapping: Mapping, spaceId: string, key: string,
    title: string, storage: string, hash: string, parentId: string | undefined,
    forceUpdate = false,
  ): Promise<UpsertResult> {
    const existing = mapping[key];
    if (existing?.pageId) {
      const changed = existing.hash !== hash || opts.force || forceUpdate;
      // 변경 없고 검증(--verify)도 안 하면 호출 없이 스킵
      if (!changed && !opts.verify && !existing.pendingMove && !opts.scope) return 'skipped';
      await assertInScope(existing.pageId);
      if (existing.pendingMove && existing.pageId === opts.scope?.id) throw new Error('스코프 루트는 이동할 수 없습니다.');
      let cur = await getPageOrNull(existing.pageId, !!existing.pendingMove);
      assertPageBaseline(existing, cur, spaceId, key, changed || !!existing.pendingMove);
      if (cur) {
        let moved = false;
        if (existing.pendingMove) {
          if (String(cur.spaceId) !== spaceId) throw new Error('이동 대상 페이지의 스페이스가 설정과 다릅니다.');
          if ((cur.parentId ?? undefined) !== parentId) {
            let targetId = parentId;
            let position = 'append';
            if (!targetId) {
              // A sibling of the top-level homepage is also top-level.
              const space = await api(`/api/v2/spaces/${spaceId}`);
              targetId = space.homepageId;
              if (!targetId) throw new Error('최상위 이동 기준 홈페이지가 없습니다. 원격 스코프를 다시 설정하세요.');
              const target = await getPageOrNull(targetId);
              if (!target || target.parentId || String(target.spaceId) !== spaceId) throw new Error('최상위 이동 기준 홈페이지를 확인할 수 없습니다.');
              position = 'after';
            }
            if (targetId === existing.pageId) throw new Error('페이지를 자기 자신 아래로 이동할 수 없습니다.');
            const priorBody = cur.body?.storage?.value;
            const priorTitle = cur.title;
            if (typeof priorBody !== 'string') throw new Error('이동 전 원격 본문을 확인할 수 없습니다.');
            if (parentId) await assertInScope(parentId);
            await api(`/rest/api/content/${existing.pageId}/move/${position}/${targetId}`, { method: 'PUT' });
            cur = await getPageOrNull(existing.pageId, true);
            if (cur?.body?.storage?.value !== priorBody || cur?.title !== priorTitle) throw new Error('이동 도중 원격 본문·제목이 변경되었습니다. 본문을 덮어쓰지 않습니다.');
            if (!cur || (cur.parentId ?? undefined) !== parentId) throw new Error('이동 후 부모 위치 검증에 실패했습니다. 다시 sync하세요.');
            moved = true;
          }
        }
        if (!changed) {
          delete existing.pendingMove;
          if (typeof cur.parentId === 'string') existing.remoteParentId = cur.parentId;
          if (moved && cur.version?.number) existing.remoteVersion = cur.version.number;
          return moved ? 'moved' : 'skipped';
        }
        await assertInScope(existing.pageId);
        const nextVersion = (cur.version?.number ?? 1) + 1;
        await api(`/api/v2/pages/${existing.pageId}`, {
          method: 'PUT',
          body: JSON.stringify({
            id: existing.pageId,
            status: 'current',
            title,
            body: { representation: 'storage', value: storage },
            version: { number: nextVersion, message: `sync from git: ${key}` },
          }),
        });
        const remoteParentId = typeof cur.parentId === 'string' ? cur.parentId : existing.remoteParentId;
        mapping[key] = { pageId: existing.pageId, title, hash, remoteVersion: nextVersion, ...(remoteParentId ? {remoteParentId} : {}) };
        return 'updated';
      }
    }
    if (opts.scope && !parentId) throw new Error('스코프 안의 부모가 필요합니다.');
    if (parentId) await assertInScope(parentId);
    const body: Record<string, unknown> = {
      spaceId, status: 'current', title,
      body: { representation: 'storage', value: storage },
    };
    if (parentId) body.parentId = parentId;
    const created = await api(`/api/v2/pages`, { method: 'POST', body: JSON.stringify(body) });
    mapping[key] = { pageId: created.id, title, hash, remoteVersion: created.version?.number ?? 1, ...(parentId ? {remoteParentId: parentId} : {}) };
    return 'created';
  }

  // ---- pull(역방향) 전용 ----

  /** v1 GET. api() 와 달리 /rest/api 계열 + 임의 expand 응답을 그대로 돌려준다. */
  async function getV1(path: string): Promise<any> {
    return api(path);
  }

  /**
   * 콘텐츠 노드 조회. type + 제목 + export_view(HTML) + storage(원본 XHTML) + 출처 메타.
   * storage 는 코드블록의 "진짜" 언어를 얻는 데 쓴다(export_view 는 언어 미지정 시 brush:java 기본값이 붙어 신뢰 불가).
   * url/updated 는 frontmatter 의 출처 정보로 쓰이며, 응답에 없으면 undefined.
   */
  async function getNode(id: string): Promise<ContentNode> {
    const data = await getV1(`/rest/api/content/${id}?expand=body.export_view,body.storage,version`);
    const base = data._links?.base;
    const webui = data._links?.webui;
    return {
      id: data.id,
      type: data.type ?? 'page',
      title: data.title ?? id,
      html: data.body?.export_view?.value ?? '',
      storage: data.body?.storage?.value ?? '',
      url: base && webui ? `${base}${webui}` : undefined,
      updated: data.version?.when,
      ...(data.version?.number !== undefined ? { version: data.version.number } : {}),
    };
  }

  /** 자식 노드 목록(kind = page|folder, 전체 페이지네이션). */
  async function listChildren(id: string, kind: 'page' | 'folder'): Promise<{ id: string; title: string }[]> {
    const out: { id: string; title: string }[] = [];
    let path: string | null = `/rest/api/content/${id}/child/${kind}?limit=100`;
    while (path) {
      const data: any = await getV1(path);
      for (const c of data.results ?? []) out.push({ id: String(c.id), title: c.title });
      const next = data._links?.next;
      path = next ? (next.startsWith('/') ? next : `/${next}`) : null;
    }
    return out;
  }
  const getChildPages = (id: string) => listChildren(id, 'page');
  const getChildFolders = (id: string) => listChildren(id, 'folder');

  /** 페이지 첨부 목록(파일명 + 다운로드 경로). */
  async function listAttachments(pageId: string): Promise<{ filename: string; downloadPath: string }[]> {
    const out: { filename: string; downloadPath: string }[] = [];
    let path: string | null = `/rest/api/content/${pageId}/child/attachment?limit=100`;
    while (path) {
      const data: any = await getV1(path);
      for (const a of data.results ?? []) {
        const downloadPath = a._links?.download;
        if (downloadPath) out.push({ filename: a.title, downloadPath });
      }
      const next = data._links?.next;
      path = next ? (next.startsWith('/') ? next : `/${next}`) : null;
    }
    return out;
  }

  /** 첨부 바이너리 다운로드. */
  async function downloadAttachment(downloadPath: string): Promise<Buffer> {
    const url = downloadPath.startsWith('http') ? downloadPath : `${cfg.baseUrl}${downloadPath}`;
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) throw new ConfluenceDownloadError(res.status, res.statusText, downloadPath);
    return Buffer.from(await res.arrayBuffer());
  }

  // ---- 폴더(README 없는 디렉토리 컨테이너) ----

  /** 콘텐츠(페이지/폴더) 존재 확인. 404 → null (v1, 폴더 read 스코프 없이도 동작). */
  async function getContentOrNull(id: string): Promise<any | null> {
    const res = await fetch(`${cfg.baseUrl}/rest/api/content/${id}`, {
      headers: { Authorization: authHeader(), Accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Confluence API ${res.status} ${res.statusText}\n/rest/api/content/${id}\n${await res.text()}`);
    return res.json();
  }

  /** 같은 스페이스·부모·제목의 폴더만 재사용한다. 검색 결과는 현재 메타로 재검증. */
  async function findFolder(spaceId: string, spaceKey: string, title: string, parentId?: string): Promise<string | null> {
    const cql = `type = folder AND space = ${JSON.stringify(spaceKey)} AND title = ${JSON.stringify(title)}`;
    let path: string | null = `/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=100`;
    const matches = new Set<string>();
    const otherParents = new Set<string>();
    let homepageId: string | undefined;
    while (path) {
      const data = await getV1(path);
      for (const candidate of data.results ?? []) {
        if (candidate.type !== 'folder' || candidate.title !== title) continue;
        const folder = await getV1(`/rest/api/content/${encodeURIComponent(candidate.id)}?expand=ancestors,space`);
        if (!Array.isArray(folder.ancestors) || !folder.space?.id) {
          throw new Error(`폴더 위치 메타데이터를 확인할 수 없습니다: ${candidate.id}`);
        }
        if (folder.type !== 'folder' || String(folder.space.id) !== spaceId || folder.title !== title) continue;
        const actualParent = folder.ancestors.at(-1)?.id;
        // The visible space root can be the homepage's children, not parentless content.
        if (!parentId && actualParent && homepageId === undefined) {
          homepageId = String((await api(`/api/v2/spaces/${spaceId}`)).homepageId ?? '');
        }
        if (actualParent === parentId || (!parentId && actualParent === homepageId)) {
          matches.add(String(folder.id));
        } else {
          otherParents.add(actualParent ?? 'ROOT');
        }
      }
      const next = data._links?.next;
      // Keep pagination on this configured API base (including gateway cloud IDs).
      path = next ? new URL(next, 'https://pagination.invalid').pathname.replace(/^\/wiki(?=\/rest\/)/, '') + new URL(next, 'https://pagination.invalid').search : null;
    }
    if (matches.size > 1) throw new Error(`같은 위치에 동명 폴더가 여러 개 있습니다: ${title}`);
    if (!matches.size && otherParents.size) {
      throw new Error(`동명 폴더 '${title}'가 다른 위치에 있습니다 (현재 부모: ${[...otherParents].join(', ')}, 요청 부모: ${parentId ?? 'ROOT/홈페이지'}). 부모 설정 또는 폴더 구조를 확인하세요.`);
    }
    return [...matches][0] ?? null;
  }

  /** 폴더 생성(write:folder 필요). parentId 없으면 공간 최상위. 생성된 folder id 반환. */
  async function createFolder(spaceId: string, title: string, parentId?: string): Promise<string> {
    if (opts.scope && !parentId) throw new Error('스코프 안의 부모가 필요합니다.');
    if (parentId) await assertInScope(parentId);
    const body: Record<string, unknown> = { spaceId, title };
    if (parentId) body.parentId = parentId;
    const created = await api(`/api/v2/folders`, { method: 'POST', body: JSON.stringify(body) });
    return created.id;
  }

  /** 조회→재사용→생성. 동시 생성/검색 지연으로 충돌하면 한 번 재조회한다. */
  async function upsertFolder(
    spaceId: string, spaceKey: string, title: string, parentId?: string, mappedId?: string,
  ): Promise<{ id: string; created: boolean }> {
    parentId = parentId?.trim() || undefined;
    if (parentId) await assertInScope(parentId);
    if (mappedId) { await assertInScope(mappedId); }
    if (mappedId) {
      let folder: any;
      try {
        folder = await api(`/rest/api/content/${encodeURIComponent(mappedId)}?expand=ancestors,space`);
      } catch (error) {
        if (!(error instanceof ConfluenceApiError) || error.status !== 404) throw error;
      }
      if (folder) {
        if (!Array.isArray(folder.ancestors) || !folder.space?.id) throw new Error(`폴더 위치 메타데이터를 확인할 수 없습니다: ${mappedId}`);
        const actualParent = folder.ancestors.at(-1)?.id;
        const homepageId = !parentId && actualParent ? String((await api(`/api/v2/spaces/${spaceId}`)).homepageId ?? '') : undefined;
        if (folder.type !== 'folder' || String(folder.space.id) !== spaceId || folder.title !== title ||
            !(actualParent === parentId || (!parentId && actualParent === homepageId))) {
          throw new Error(`매핑 폴더 #${mappedId}의 스페이스·제목·부모가 '${title}'의 요청 위치와 다릅니다.`);
        }
        return { id: mappedId, created: false };
      }
      throw new Error(`매핑 폴더 #${mappedId}가 없습니다. 자동 재생성하지 않습니다.`);
    }
    const found = await findFolder(spaceId, spaceKey, title, parentId);
    if (found) return { id: found, created: false };
    try {
      return { id: await createFolder(spaceId, title, parentId), created: true };
    } catch (error) {
      const conflict = error instanceof ConfluenceApiError &&
        (error.status === 409 || (error.status === 400 && /folder exists with the same title/i.test(error.responseBody)));
      if (!conflict) throw error;
      const raced = await findFolder(spaceId, spaceKey, title, parentId);
      if (raced) return { id: raced, created: false };
      throw error;
    }
  }

  return {
    api, getContentInfo, assertInScope, getPageOrNull, getSpaceId, getSpaceInfo, uploadImages, uploadAttachments, upsertPage, checkPage,
    getNode, getChildPages, getChildFolders, listAttachments, downloadAttachment,
    getContentOrNull, findFolder, createFolder, upsertFolder,
  };
}
