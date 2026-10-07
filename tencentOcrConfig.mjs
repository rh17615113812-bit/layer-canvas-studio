import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export function saveTencentOcrConfig(root, secretId, secretKey) {
  if (typeof secretId !== 'string' || typeof secretKey !== 'string') throw new Error('请填写 SecretId 和 SecretKey。');
  secretId = secretId.trim(); secretKey = secretKey.trim();
  if (!/^AKID[A-Za-z0-9]{8,128}$/.test(secretId) || !/^[A-Za-z0-9_+\/=-]{16,256}$/.test(secretKey)) throw new Error('腾讯云密钥格式无效，请检查复制内容。');
  const path = resolve(root, '.env.local'), temporary = `${path}.tencent.tmp`;
  let source = existsSync(path) ? readFileSync(path, 'utf8') : '# 本地服务端配置，请勿提交到 Git。\n';
  for (const [name, value] of [['TENCENT_SECRET_ID', secretId], ['TENCENT_SECRET_KEY', secretKey]]) {
    const expression = new RegExp(`^\\s*${name}\\s*=.*$`, 'gm');
    source = expression.test(source) ? source.replace(expression, `${name}=${value}`) : `${source.trimEnd()}\n${name}=${value}\n`;
  }
  try { writeFileSync(temporary, source, { mode: 0o600 }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
  return { secretId, secretKey };
}
