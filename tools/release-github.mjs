#!/usr/bin/env node
/* ============================================================================
 *  release-github.mjs —— 补仓库信息、建 Release、上传安装包
 *
 *  用法：
 *    node tools/release-github.mjs --repo <owner>/<name> [--tag v1.0.0]
 *         [--notes <file.md>] [--asset <file.exe>] [--topics a,b,c] [--dry]
 *
 *  令牌从哪来（按顺序找）：
 *    1. 环境变量 GITHUB_TOKEN
 *    2. `git credential fill`（也就是 Git Credential Manager 里存的那份 ——
 *       `git push` 能成功就说明它在）
 *  令牌只在本进程内使用，不打印、不落盘。
 *
 *  为什么要有这个脚本：仓库的「描述 / 主页 / Topics」在网页上点三下就改完了，
 *  但每次发版都要重复做，而 Release 附件（70+MB 的安装包）用网页上传更容易出错。
 *  写成脚本之后，发布就是一条命令。
 * ========================================================================== */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { request as httpsRequest } from 'node:https';

const API = 'https://api.github.com';

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

const repo = arg('repo') ?? 'sonshpx-code/Elegant-Internet-Speed-Display-Widget---Windows';
const tag = arg('tag') ?? 'v1.0.0';
const dry = arg('dry') === true;
const notesFile = arg('notes');
const asset = arg('asset');
const topics = (arg('topics') ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

/** 拿令牌：优先环境变量，其次问 Git Credential Manager。 */
function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const match = out.match(/^password=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* 没有就算了，下面会给明确的报错 */ }
  return null;
}

async function api(token, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'net-hud-release-script',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text === '' ? null : JSON.parse(text); } catch { body = text; }
  if (!response.ok) {
    const detail = body && typeof body === 'object' ? body.message : String(body).slice(0, 200);
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${detail}`);
  }
  return body;
}

const token = getToken();
if (!token) {
  console.error('没有令牌：设置 GITHUB_TOKEN 环境变量，或先用 git 登录一次 GitHub。');
  process.exit(1);
}

/** 先看令牌是谁、有哪些权限，免得后面报错看不懂。 */
async function whoami() {
  try {
    const user = await api(token, '/user');
    return user.login;
  } catch {
    return '(令牌无法读取 /user)';
  }
}

async function main() {
  console.log('仓库 :', repo);
  console.log('身份 :', await whoami());

  if (topics.length > 0) {
    if (dry) console.log('  [dry] 设置 topics:', topics.join(', '));
    else {
      const updated = await api(token, `/repos/${repo}/topics`, {
        method: 'PUT',
        headers: { accept: 'application/vnd.github.mercy-preview+json' },
        body: JSON.stringify({ names: topics }),
      });
      console.log('  topics ->', (updated.names ?? []).join(', '));
    }
  }

  // 默认把主页指回仓库自己（README 里的图片和链接都相对仓库走）
  if (dry) console.log('  [dry] 主页 -> https://github.com/' + repo);
  else {
    const patched = await api(token, `/repos/${repo}`, {
      method: 'PATCH',
      body: JSON.stringify({ homepage: `https://github.com/${repo}` }),
    });
    console.log('  主页 ->', patched.homepage);
  }

  if (notesFile === undefined && asset === undefined) {
    console.log('（未指定 --notes / --asset，跳过 Release）');
    return;
  }

  const body = notesFile ? readFileSync(notesFile, 'utf8') : '';
  const title = `Net HUD ${tag.replace(/^v/, '')}`;

  let release = null;
  try {
    release = await api(token, `/repos/${repo}/releases/tags/${tag}`);
    console.log('Release 已存在:', release.html_url);
  } catch {
    if (dry) console.log(`  [dry] 创建 Release ${tag}`);
    else {
      release = await api(token, `/repos/${repo}/releases`, {
        method: 'POST',
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: 'main',
          name: title,
          body,
          draft: false,
          prerelease: false,
        }),
      });
      console.log('Release 已创建:', release.html_url);
    }
  }

  if (asset && release) {
    const size = statSync(asset).size;
    const name = basename(asset);
    const existing = (release.assets ?? []).find((a) => a.name === name);
    if (existing) {
      if (dry) console.log(`  [dry] 替换附件 ${name}`);
      else {
        await api(token, `/repos/${repo}/releases/assets/${existing.id}`, { method: 'DELETE' });
        console.log('  已删除同名旧附件');
      }
    }
    if (dry) console.log(`  [dry] 上传附件 ${name} (${(size / 1048576).toFixed(1)} MB)`);
    else {
      // 附件走 uploads.github.com，用原始流上传（70MB 走内存不合适）
      const upload = await new Promise((resolve, reject) => {
        const url = `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
        const request = httpsRequest(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/octet-stream',
            'content-length': size,
            'user-agent': 'net-hud-release-script',
          },
        }, (response) => {
          let text = '';
          response.on('data', (chunk) => { text += chunk; });
          response.on('end', () => {
            if (response.statusCode >= 200 && response.statusCode < 300) resolve(JSON.parse(text));
            else reject(new Error(`upload -> ${response.statusCode} ${text.slice(0, 200)}`));
          });
        });
        request.on('error', reject);
        createReadStream(asset).pipe(request);
      });
      console.log(`  附件已上传: ${upload.name} (${(upload.size / 1048576).toFixed(1)} MB)`);
      console.log('  下载地址:', upload.browser_download_url);
    }
  }
}

main().catch((error) => {
  console.error('失败:', error.message);
  process.exit(1);
});
