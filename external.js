'use strict';
// GitHub 연동 도구 (읽기 기본, 쓰기는 GITHUB_ALLOW_WRITE=1 이고 사용자 확인이 있을 때만)
// 토큰은 process.env.GITHUB_TOKEN 에서만 읽고, 응답·에러·로그에 넣지 않는다. Render 의 Environment 탭에 설정.
const API = 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN || '';
const ALLOW_WRITE = process.env.GITHUB_ALLOW_WRITE === '1';
const TTL = 5 * 60_000, CACHE_MAX = 200, RATE_MAX = 30;

const cache = new Map();
const hits = [];
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });
const clampInt = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d));
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined).map(k => [k, o[k]]));

function checkRepo(owner, repo) {
  if (!OWNER.test(String(owner || '')) || !REPO.test(String(repo || '')) || repo === '.' || repo === '..') {
    throw new Error('owner/repo 형식이 올바르지 않습니다');
  }
}
function checkPath(p) {
  if (typeof p !== 'string' || p.length > 300 || p.split('/').some(s => s === '..')) throw new Error('경로가 올바르지 않습니다');
  return p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}
function rateOk() {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60_000) hits.shift();
  if (hits.length >= RATE_MAX) return false;
  hits.push(now);
  return true;
}

async function gh(path, { method = 'GET', body, cacheable = true } = {}) {
  if (!rateOk()) throw new Error(`GitHub 호출 한도(분당 ${RATE_MAX}회)를 초과했습니다`);
  const key = method + path;
  if (cacheable && cache.has(key) && Date.now() - cache.get(key).t < TTL) return cache.get(key).v;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'gims-ai' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404) throw new Error('찾을 수 없음(404): 저장소·경로·권한을 확인하세요');
  if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') throw new Error('GitHub 속도 제한에 걸렸습니다');
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${String(j.message || '').slice(0, 120)}`);
  if (cacheable) {
    cache.set(key, { t: Date.now(), v: j });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return j;
}

const IMPL = {};

IMPL.github_repo_info = async ({ owner, repo }) => {
  checkRepo(owner, repo);
  const j = await gh(`/repos/${owner}/${repo}`);
  return pick(j, ['full_name', 'description', 'language', 'stargazers_count', 'open_issues_count', 'default_branch', 'license', 'pushed_at', 'html_url']);
};

IMPL.github_list_issues = async ({ owner, repo, state = 'open', per_page = 10 }) => {
  checkRepo(owner, repo);
  const st = ['open', 'closed', 'all'].includes(state) ? state : 'open';
  const j = await gh(`/repos/${owner}/${repo}/issues?state=${st}&per_page=${clampInt(per_page, 1, 30, 10)}`);
  return {
    issues: j.filter(i => !i.pull_request).map(i => ({
      number: i.number, title: i.title, state: i.state, created_at: i.created_at, comments: i.comments,
      labels: (i.labels || []).map(l => (typeof l === 'string' ? l : l.name)),
      body: String(i.body || '').slice(0, 500)
    }))
  };
};

IMPL.github_list_commits = async ({ owner, repo, per_page = 10 }) => {
  checkRepo(owner, repo);
  const j = await gh(`/repos/${owner}/${repo}/commits?per_page=${clampInt(per_page, 1, 30, 10)}`);
  return { commits: j.map(c => ({ sha: c.sha.slice(0, 10), message: String(c.commit.message).split('\n')[0].slice(0, 200), author: c.commit.author?.name, date: c.commit.author?.date })) };
};

IMPL.github_get_file = async ({ owner, repo, path, ref }) => {
  checkRepo(owner, repo);
  const p = checkPath(path);
  const q = ref ? `?ref=${encodeURIComponent(String(ref).slice(0, 100))}` : '';
  const j = await gh(`/repos/${owner}/${repo}/contents/${p}${q}`);
  if (Array.isArray(j)) return { type: 'dir', entries: j.map(e => `${e.type}:${e.name}`).slice(0, 200) };
  if (j.size > 60000) return { type: 'file', path: j.path, size: j.size, note: '60KB 초과: 내용 생략' };
  if (j.encoding !== 'base64') throw new Error('텍스트로 읽을 수 없는 파일입니다');
  return { type: 'file', path: j.path, size: j.size, content: Buffer.from(j.content, 'base64').toString('utf8') };
};

IMPL.github_search_repos = async ({ query, per_page = 5 }) => {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('query 는 1~200자여야 합니다');
  const j = await gh(`/search/repositories?q=${encodeURIComponent(query)}&per_page=${clampInt(per_page, 1, 10, 5)}`);
  return { total: j.total_count, items: (j.items || []).map(i => pick(i, ['full_name', 'description', 'stargazers_count', 'language', 'html_url'])) };
};

IMPL.github_create_issue = async ({ owner, repo, title, body = '' }, ctx = {}) => {
  if (!ALLOW_WRITE || !ctx.userConfirmedWrite) throw new Error('쓰기 작업이 비활성화되었거나 사용자 확인이 없습니다');
  checkRepo(owner, repo);
  if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('title 은 1~200자여야 합니다');
  const j = await gh(`/repos/${owner}/${repo}/issues`, { method: 'POST', body: { title, body: String(body).slice(0, 5000) }, cacheable: false });
  return { created: j.number, url: j.html_url };
};

const REPO_PROPS = { owner: S('STRING', '저장소 소유자'), repo: S('STRING', '저장소 이름') };
const DECL = [
  { name: 'github_repo_info', description: 'GitHub 저장소 기본 정보(언어, 별 수, 기본 브랜치, 최근 푸시 등).',
    parameters: OBJ({ ...REPO_PROPS }, ['owner', 'repo']) },
  { name: 'github_list_issues', description: '저장소 이슈 목록(PR 제외).',
    parameters: OBJ({ ...REPO_PROPS, state: S('STRING', 'open, closed, all', { enum: ['open', 'closed', 'all'] }), per_page: S('INTEGER', '개수 (최대 30)') }, ['owner', 'repo']) },
  { name: 'github_list_commits', description: '최근 커밋 목록.',
    parameters: OBJ({ ...REPO_PROPS, per_page: S('INTEGER', '개수 (최대 30)') }, ['owner', 'repo']) },
  { name: 'github_get_file', description: '저장소의 텍스트 파일 내용 또는 디렉터리 목록(60KB 이하 파일).',
    parameters: OBJ({ ...REPO_PROPS, path: S('STRING', '파일 경로, 예: src/index.js'), ref: S('STRING', '브랜치·태그·커밋 (선택)') }, ['owner', 'repo', 'path']) },
  { name: 'github_search_repos', description: 'GitHub 저장소 검색.',
    parameters: OBJ({ query: S('STRING', '검색어, 예: "text adventure language:javascript"'), per_page: S('INTEGER', '개수 (최대 10)') }, ['query']) },
  { name: 'github_create_issue', description: '[쓰기] 이슈 생성. 서버 설정(GITHUB_ALLOW_WRITE)과 사용자의 명시적 승인이 있어야만 실행된다.',
    parameters: OBJ({ ...REPO_PROPS, title: S('STRING', '제목'), body: S('STRING', '본문') }, ['owner', 'repo', 'title']) }
];

module.exports = { DECL, IMPL };
