/**
 * 환경변수(.env / 셸) 로딩과 필수값 검증.
 * dotenv 로딩은 진입점(sync.ts)에서 `import 'dotenv/config'` 로 먼저 수행된다.
 */
import { red, cyan } from './colors.js';

export type Env = {
  baseUrl?: string;
  email?: string;
  token?: string;
  spaceKey?: string;
  parentPageId?: string;
};

export function readEnv(): Env {
  return {
    baseUrl: process.env.CONFLUENCE_BASE_URL,
    email: process.env.CONFLUENCE_EMAIL,
    token: process.env.CONFLUENCE_API_TOKEN,
    spaceKey: process.env.CONFLUENCE_SPACE_KEY,
    parentPageId: process.env.CONFLUENCE_PARENT_PAGE_ID,
  };
}

/** 동기화(생성/갱신)에 필요한 필수 환경변수 검증. 누락 시 종료. */
export function requireEnv(env: Env): void {
  const missing = [
    ['CONFLUENCE_BASE_URL', env.baseUrl],
    ['CONFLUENCE_EMAIL', env.email],
    ['CONFLUENCE_API_TOKEN', env.token],
    ['CONFLUENCE_SPACE_KEY', env.spaceKey],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(red(`환경변수 누락: ${missing.join(', ')}`) + `\n${cyan('confluence-sync init')} 으로 .env 를 만들 수 있습니다.`);
    process.exit(1);
  }
}
