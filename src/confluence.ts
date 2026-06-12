/**
 * Confluence Cloud API 클라이언트. createClient(config, opts) 로 생성하면
 * baseUrl·인증·force/verify 옵션을 클로저로 묶은 메서드 집합을 돌려준다.
 */
import { readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { Mapping } from './mapping.js';
import { red, yellow, dim } from './colors.js';

export type ConfluenceConfig = { baseUrl: string; email: string; token: string };
export type ClientOpts = { force: boolean; verify: boolean };
export type UpsertResult = 'created' | 'updated' | 'skipped' | 'recreated';
export type ImageRef = { filename: string; abs: string };

export function createClient(cfg: ConfluenceConfig, opts: ClientOpts) {
  const authHeader = () => 'Basic ' + Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64');

  async function api(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`Confluence API ${res.status} ${res.statusText}\n${path}\n${await res.text()}`);
    }
    return res.status === 204 ? null : res.json();
  }

  /** 페이지 조회. 삭제(휴지통)·부재면 404 → null 반환(그 외 오류는 throw) */
  async function getPageOrNull(pageId: string): Promise<any | null> {
    const res = await fetch(`${cfg.baseUrl}/api/v2/pages/${pageId}`, {
      headers: { Authorization: authHeader(), Accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Confluence API ${res.status} ${res.statusText}\n/api/v2/pages/${pageId}\n${await res.text()}`);
    return res.json();
  }

  async function getSpaceId(key: string): Promise<string> {
    const data = await api(`/api/v2/spaces?keys=${encodeURIComponent(key)}`);
    const space = data.results?.[0];
    if (!space) throw new Error(`Space key '${key}' 를 찾을 수 없습니다.`);
    return space.id;
  }

  /** 매핑에 기록된 페이지를 모두 삭제(휴지통). 매핑 파일 영속화는 호출자 책임. */
  async function deleteAll(mapping: Mapping): Promise<void> {
    const entries = Object.entries(mapping);
    console.log(yellow(`--rebuild: 기존 페이지 ${entries.length}건 삭제`));
    for (const [key, { pageId }] of entries) {
      try {
        await api(`/api/v2/pages/${pageId}`, { method: 'DELETE' });
        console.log(`  ${yellow('🗑  삭제')} ${key} ${dim(`(#${pageId})`)}`);
      } catch (e) {
        console.error(red(`  ✗ 삭제 실패 ${key}`) + `\n${(e as Error).message}`);
      }
    }
  }

  /** 로컬 이미지를 페이지 첨부로 업로드(v1 POST, multipart). 같은 파일명은 새 버전으로 갱신. */
  async function uploadAttachment(pageId: string, filename: string, abs: string): Promise<void> {
    const buf = readFileSync(abs);
    const form = new FormData();
    form.append('file', new Blob([buf]), filename);
    form.append('minorEdit', 'true');
    const res = await fetch(`${cfg.baseUrl}/rest/api/content/${pageId}/child/attachment`, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'X-Atlassian-Token': 'nocheck' },
      body: form as any,
    });
    if (!res.ok) throw new Error(`attachment ${res.status} ${res.statusText}\n${await res.text()}`);
  }

  /** 페이지의 로컬 이미지들을 업로드. 성공 개수 반환. baseDir 은 로그 표시용. */
  async function uploadImages(pageId: string, images: ImageRef[], baseDir: string): Promise<number> {
    let ok = 0;
    for (const img of images) {
      if (!existsSync(img.abs)) { console.error(yellow(`    ⚠ 이미지 없음: ${relative(baseDir, img.abs)}`)); continue; }
      try { await uploadAttachment(pageId, img.filename, img.abs); ok++; }
      catch (e) { console.error(red(`    ✗ 이미지 업로드 실패 ${img.filename}`) + `\n${(e as Error).message}`); }
    }
    return ok;
  }

  /** 페이지 생성/갱신. 삭제 감지 시 재생성. 변경 없으면(opts.verify 아니면) 호출 없이 skip. */
  async function upsertPage(
    mapping: Mapping, spaceId: string, key: string,
    title: string, storage: string, hash: string, parentId: string | undefined,
    forceUpdate = false,
  ): Promise<UpsertResult> {
    const existing = mapping[key];
    if (existing?.pageId) {
      const changed = existing.hash !== hash || opts.force || forceUpdate;
      // 변경 없고 검증(--verify)도 안 하면 호출 없이 스킵
      if (!changed && !opts.verify) return 'skipped';
      const cur = await getPageOrNull(existing.pageId);
      if (cur) {
        if (!changed) return 'skipped'; // 페이지 존재 확인됨, 내용도 동일
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
        mapping[key] = { pageId: existing.pageId, title, hash };
        return 'updated';
      }
      // cur === null: Confluence 에서 삭제됨 → 아래에서 신규 생성으로 복구
    }
    const body: Record<string, unknown> = {
      spaceId, status: 'current', title,
      body: { representation: 'storage', value: storage },
    };
    if (parentId) body.parentId = parentId;
    const created = await api(`/api/v2/pages`, { method: 'POST', body: JSON.stringify(body) });
    mapping[key] = { pageId: created.id, title, hash };
    return existing?.pageId ? 'recreated' : 'created';
  }

  return { api, getPageOrNull, getSpaceId, deleteAll, uploadImages, upsertPage };
}
