/**
 * 환경변수(.env / 셸) 로딩과 필수값 검증.
 * 작업공간 .env를 읽고 셸 환경변수를 우선 적용한다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { red, cyan } from '../shared/colors.js';

export type Env = {
  baseUrl?: string;
  email?: string;
  token?: string;
  spaceKey?: string;

};

export function readEnv(base?: string): Env {
  const read = (dir: string) => existsSync(join(dir, '.env')) ? parse(readFileSync(join(dir, '.env'))) : {};
  const dir = base && existsSync(join(base, '.env')) ? base : process.cwd();
  const values = { ...read(dir), ...process.env };
  return {
    baseUrl: values.CONFLUENCE_BASE_URL,
    email: values.CONFLUENCE_EMAIL,
    token: values.CONFLUENCE_API_TOKEN,
    spaceKey: values.CONFLUENCE_SPACE_KEY,

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
