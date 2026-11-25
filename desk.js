// 科普视频审稿台网页：登录（GitHub 口令）→ 先选领域、再选哪一步（三选一 / 细改 / 听评）→ 打开一集（页面在下面的框里）→ 提交写回私有仓库。
// 这个文件只有程序，不含任何讲稿；讲稿、配音都在私有仓库里，登录后才取得到。纯函数在 core.js。
import {
  STAGES, STAGE_HINT, STATE_NAME, ago, b64, domainOf, domainsOf, draftKey, encPath, firstStop, isStale, lockOf, makeHash, makeResult, nextRow, normRepo,
  openCount, parseHash, parseTree, payloadOk, resultToShow, rows, stateOfResult, summary,
} from './core.js?v=20261120b';

const APP = '2026-11-20';
const API = 'https://api.github.com';
const $ = (id) => document.getElementById(id);
const S = { repo: '', token: '', login: '', branch: 'main', canPush: false, isPrivate: true, tree: null, desk: null, domain: '', stage: '', mineOnly: false,
  claimInfo: {}, current: null, timer: 0, lastRefresh: 0 };

// ---------------------------------------------------------------- 存取（浏览器本地）
const ls = {
  get: (k) => { try { return localStorage.getItem('desk.' + k) || sessionStorage.getItem('desk.' + k) || ''; } catch { return ''; } },
  set: (k, v, remember = true) => { try { (remember ? localStorage : sessionStorage).setItem('desk.' + k, v); return true; } catch { return false; } },
  del: (k) => { try { localStorage.removeItem('desk.' + k); sessionStorage.removeItem('desk.' + k); } catch { /* 隐私模式 */ } },
  /** 这台电脑上存的草稿全清掉（退出时：别把填过的内容留给下一个用这台电脑的人） */
  clearDrafts: () => {
    try {
      for (const st of [localStorage, sessionStorage]) for (const k of Object.keys(st)) if (k.startsWith('desk.draft:')) st.removeItem(k);
    } catch { /* 隐私模式 */ }
  },
};
/** 管理员（desk.json 的 admins，流水线那边 config/desk.json 定）：谁交的都能清空、谁的认领都能放。锁只是网页上的规矩，防的是误操作。 */
const admins = () => (S.desk && Array.isArray(S.desk.admins) ? S.desk.admins : []);
const isAdmin = () => admins().includes(S.login);
/** 锁住时顶上和提交按钮旁边说的话 */
function lockText(lk) {
  if (lk.why === 'imported') return '这一集已经导入流水线了，只能看、不能再交。要重做找管理员。';
  if (lk.why === 'done') return `${lk.by} 已经交过这一集，你只能看、不能再交。要重做，得 ${lk.by} 自己清空，或者找管理员清空。`;
  return `${lk.by || '有人'} 正在做这一集，你只能看、不能交。等对方交完或放弃认领；认领超过 12 小时没交可以接手。`;
}
const drafts = {
  get(stage, pid) { try { return JSON.parse(ls.get(draftKey(S.repo, stage, pid)) || 'null'); } catch { return null; } },
  set(stage, pid, d) { return ls.set(draftKey(S.repo, stage, pid), JSON.stringify(d)); },
  del(stage, pid) { ls.del(draftKey(S.repo, stage, pid)); },
};

// ---------------------------------------------------------------- 提示条（不用弹窗：出错、提醒都在顶上滑一条）
let toastTimer = 0;
function toast(text, kind = '') {
  const t = $('toast');
  t.textContent = text;
  t.className = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'bad' ? 9000 : 4500);
}

// ---------------------------------------------------------------- GitHub 接口
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = { Authorization: `Bearer ${S.token}`, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const init = { method, headers, cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(API + path, init);
  } catch {
    const e = new Error('连不上 GitHub（网络断了？）');
    e.status = 0;
    throw e;
  }
  if (r.status === 204) return null;
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).message || ''; } catch { /* 不是 json */ }
    const e = new Error(`${r.status} ${msg}`);
    e.status = r.status;
    throw e;
  }
  return raw ? r.text() : r.json();
}
const R = () => `/repos/${S.repo}`;
const C = (p) => `${R()}/contents/${encPath(p)}`;
const ref = () => `?ref=${encodeURIComponent(S.branch)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function explain(e) {
  if (!e) return '不知道哪里错了';
  if (e.status === 401) return '口令不对或已过期：退出后重新登录';
  if (e.status === 403) return '没有权限（口令的 Contents 要选 Read and write），或者一小时内请求太多';
  if (e.status === 404) return '找不到（仓库名写错了，或口令没有这个仓库的权限）';
  if (e.status === 409) return '仓库正忙（别人同时在交），再点一次';
  return e.message || String(e);
}

async function getText(path) { return api(C(path) + ref(), { raw: true }); }
async function getJson(path) { return JSON.parse(await getText(path)); }
async function shaOf(path) {
  try { return (await api(C(path) + ref())).sha; } catch (e) { if (e.status === 404) return ''; throw e; }
}
/** 写一个 json 文件；sha 给了 = 覆盖，不给 = 新建（已经在就 422）。别人同时在交时 409，等一下再试 */
async function putJson(path, obj, message, sha) {
  const body = { message, content: b64(JSON.stringify(obj, null, 1) + '\n'), branch: S.branch };
  if (sha) body.sha = sha;
  for (let i = 0; ; i++) {
    try { return await api(C(path), { method: 'PUT', body }); } catch (e) {
      if (e.status === 409 && i < 5) { await sleep(500 * (i + 1)); continue; }
      throw e;
    }
  }
}
async function delFile(path, sha, message) {
  for (let i = 0; ; i++) {
    try { return await api(C(path), { method: 'DELETE', body: { message, sha, branch: S.branch } }); } catch (e) {
      if (e.status === 409 && i < 5) { await sleep(500 * (i + 1)); continue; }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- 登录
async function enter(repo, token, remember) {
  S.repo = normRepo(repo);
  S.token = String(token || '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(S.repo)) throw new Error('审稿仓库写成「账号/仓库名」');
  if (!S.token) throw new Error('贴上口令');
  const me = await api('/user');
  S.login = me.login;
  const info = await api(R());
  S.branch = info.default_branch || 'main';
  S.canPush = !!(info.permissions && info.permissions.push);
  S.isPrivate = !!info.private;
  ls.set('repo', S.repo);
  ls.del('token');
  ls.set('token', S.token, remember);
}

function showLogin(msg = '') {
  clearInterval(S.timer);
  $('login').hidden = false;
  $('list').hidden = true;
  $('task').hidden = true;
  $('top').hidden = true;
  const q = new URLSearchParams(location.search).get('repo');
  $('repo').value = normRepo(q || ls.get('repo') || '');
  $('loginmsg').textContent = msg;
  ($('repo').value ? $('token') : $('repo')).focus();
}

// ---------------------------------------------------------------- 列表
async function load() {
  let t;
  try {
    t = await api(`${R()}/git/trees/${encodeURIComponent(S.branch)}?recursive=1`);
  } catch (e) {
    if (e.status === 409 || e.status === 404) t = { tree: [] }; // 空仓库
    else throw e;
  }
  S.tree = parseTree(t.tree || []);
  try { S.desk = await getJson('desk.json'); } catch { S.desk = S.desk || { episodes: {} }; }
  const need = [];
  for (const st of Object.keys(STAGES)) {
    for (const [pid, path] of Object.entries(S.tree.claims[st])) {
      const key = `${st}/${pid}`;
      const sha = S.tree.sha[path];
      if (S.claimInfo[key] && S.claimInfo[key].sha === sha) continue;
      if ((S.tree.results[st][pid] || []).length || S.tree.imported[st][pid]) continue; // 交了的不用知道谁认领的
      need.push(getJson(path).then((c) => { S.claimInfo[key] = { ...c, sha }; }).catch(() => {}));
    }
  }
  await Promise.all(need);
  S.lastRefresh = Date.now();
}
async function refresh() {
  await load();
  if (!S.current) renderList();
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : String(k));
  return n;
}

/** 每个阶段的全部行（所有领域） */
function allRows() {
  const out = {};
  for (const st of Object.keys(STAGES)) out[st] = rows(S.tree, S.desk, S.claimInfo, S.login, st);
  return out;
}
const inDomain = (rs, d) => rs.filter((r) => domainOf(r) === d);
const where = (ep, pid) => [ep.episode, ep.part && `${ep.part}集`, ep.frames && `第 ${ep.frames} 帧`, ep.minutes && `目标 ${ep.minutes} 分钟`, pid].filter(Boolean).join(' · ');

/** 现在看哪个领域、哪一步：地址栏 > 上次看的 > 第一个有活的 */
function settle(by) {
  const domains = domainsOf(Object.values(by).flat(), (S.desk && S.desk.domain_order) || []);
  const first = firstStop(by, domains);
  if (!domains.includes(S.domain)) S.domain = domains.includes(ls.get('domain')) ? ls.get('domain') : first.domain;
  if (!STAGES[S.stage]) {
    const mine = Object.keys(STAGES).find((st) => openCount(inDomain(by[st], S.domain)));
    S.stage = mine || Object.keys(STAGES).find((st) => inDomain(by[st], S.domain).length) || first.stage;
  }
  return domains;
}

function setView(v, push = false) {
  Object.assign(S, v);
  if (v.domain !== undefined) ls.set('domain', S.domain);
  const h = makeHash({ domain: S.domain, stage: S.stage, pid: S.current ? S.current.pid : '' });
  if (location.hash !== h) { try { history[push ? 'pushState' : 'replaceState'](null, '', h); } catch { /* 沙箱里不让改地址 */ } }
}

function renderList() {
  $('login').hidden = true;
  $('task').hidden = true;
  $('list').hidden = false;
  $('top').hidden = false;
  $('who').textContent = `${S.login} · ${S.repo}${S.canPush ? '' : ' · 只读（口令没有写权限，交不了）'}${S.isPrivate ? '' : ' · ⚠ 这个仓库是公开的'}`;
  const by = allRows();
  const domains = settle(by);
  setView({});
  // 领域页签（11-12 用户：先选领域，每个领域下面才是三选一 / 细改 / 听评）
  const dn = $('domains');
  dn.textContent = '';
  dn.hidden = domains.length < 2;
  for (const d of domains) {
    const open = Object.keys(STAGES).reduce((n, st) => n + openCount(inDomain(by[st], d)), 0);
    dn.append(el('button', { class: d === S.domain ? 'on' : '', onclick: () => { setView({ domain: d, stage: '' }); renderList(); } },
      el('b', {}, d), el('span', {}, open ? `还剩 ${open}` : '都做完了')));
  }
  // 这个领域下的三步
  const tabs = $('tabs');
  tabs.textContent = '';
  Object.entries(STAGES).forEach(([st, name], i) => {
    const rs = inDomain(by[st], S.domain);
    const open = openCount(rs);
    if (i) tabs.append(el('span', { class: 'arrow' }, '→'));
    tabs.append(el('button', { class: (st === S.stage ? 'on' : '') + (rs.length ? '' : ' none'), title: STAGE_HINT[st], onclick: () => { setView({ stage: st }); renderList(); } },
      `${'①②③'[i]} ${name}`, el('span', {}, open ? `还剩 ${open}` : rs.length ? '做完了' : '还没有')));
  });
  tabs.append(el('label', { class: 'mine' }, el('input', { type: 'checkbox', checked: S.mineOnly, onchange: (e) => { S.mineOnly = e.target.checked; renderList(); } }), ' 只看我的'));
  $('stagehint').textContent = STAGE_HINT[S.stage] || '';
  // 我没做完的（哪个领域、哪一步的都提醒）
  const mine = Object.values(by).flat().filter((r) => r.state === 'mine');
  const cont = $('continue');
  cont.textContent = '';
  cont.hidden = !mine.length;
  if (mine.length) {
    cont.append(`你有 ${mine.length} 集做到一半：`);
    for (const r of mine.slice(0, 3)) cont.append(el('button', { onclick: () => openRow(r) }, `继续 ${STAGES[r.stage]} · ${(r.ep.title || r.pid).slice(0, 18)}${r.ep.part ? `（${r.ep.part}）` : ''}`));
  }
  // 进度
  const all = inDomain(by[S.stage], S.domain);
  const sm = summary(all);
  const bar = $('progress');
  bar.textContent = '';
  if (sm.total) {
    const seg = (n, cls) => (n ? el('span', { class: 'seg ' + cls, style: `flex:${n}` }) : null);
    bar.append(el('div', { class: 'bar' }, seg(sm.imported, 'imported'), seg(sm.done, 'done'), seg(sm.mine + sm.taken, 'taken'), seg(sm.free, 'free')));
    bar.append(el('div', { class: 'legend' },
      `共 ${sm.total} 集：`, el('i', { class: 'imported' }), `已导入 ${sm.imported}　`, el('i', { class: 'done' }), `已完成 ${sm.done}　`,
      el('i', { class: 'taken' }), `在做 ${sm.mine + sm.taken}（我 ${sm.mine}）　`, el('i', { class: 'free' }), `没人做 ${sm.free}`));
  }
  // 表
  const tb = $('rows');
  tb.textContent = '';
  const rs = S.mineOnly ? all.filter((r) => r.state === 'mine' || r.mineDone || (r.claim && r.claim.by === S.login)) : all;
  if (!rs.length) {
    const why = all.length ? '这一步没有我的' : S.stage === 'pick' ? '这个领域还没有要挑的' : `这个领域还没有到「${STAGES[S.stage]}」这一步的：前一步交完、我们处理好就会出现在这里`;
    tb.append(el('tr', {}, el('td', { colspan: 3, class: 'empty' }, why)));
  }
  for (const r of rs) {
    const ep = r.ep || {};
    const d = drafts.get(r.stage, r.pid);
    const hasDraft = d && !d.submitted && d.pageSha === (S.tree.tasks[r.stage][r.pid] || {}).pageSha;
    const what = el('div', {}, el('b', {}, ep.title || r.pid), el('div', { class: 'sub' }, where(ep, r.pid)));
    let st = STATE_NAME[r.state];
    if (r.state === 'taken' || r.state === 'mine') st += r.claim && r.claim.by ? `：${r.claim.by}，${ago(r.claim.at)}` : '';
    if (r.state === 'done' || r.state === 'imported') st += `：${r.results.join('、')}`;
    if (hasDraft) st += ` · 有没交的草稿（${ago(d.at)}）`;
    const label = { free: '开始', mine: '继续', taken: isStale(r.claim) ? '接手' : '看看', done: r.mineDone ? '再看 / 改' : '看看', imported: '看看' }[r.state];
    const primary = r.state === 'free' || r.state === 'mine';
    tb.append(el('tr', { class: 's-' + r.state, tabindex: 0, onclick: () => openRow(r), onkeydown: (e) => { if (e.key === 'Enter') openRow(r); } },
      el('td', {}, what),
      el('td', { class: 'state' }, el('span', { class: 'dot ' + r.state }), st),
      el('td', { class: 'act' }, el('button', { class: primary ? 'primary' : '', onclick: (e) => { e.stopPropagation(); openRow(r); } }, label))));
  }
  $('fresh').textContent = S.lastRefresh ? `列表每分钟自己刷新（上次 ${new Date(S.lastRefresh).toLocaleTimeString('zh-CN', { hour12: false })}）` : '';
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (!$('list').hidden) refresh().catch(() => {}); }, 60000);
}

// ---------------------------------------------------------------- 打开一集
function openRow(r) {
  openTask(r).catch((e) => { toast('打不开：' + explain(e), 'bad'); backToList().catch(() => {}); });
}

async function openTask(r, push = true) {
  const { stage, pid } = r;
  const claimPath = `claims/${stage}/${pid}.json`;
  let raced = ''; // 我点开的同时别人先认领了：是谁
  if (r.state === 'taken' && isStale(r.claim || {})) { // 认领超过 12 小时没交：可以接手。没过期的不问、不认领，打开只能看（锁，11-20）
    const c = r.claim || {};
    if (!confirm(`${c.by || '有人'} ${ago(c.at)}认领了这一集，一直没交。\n\n打开就算你接手，仍要打开吗？`)) return;
    if (S.canPush) {
      try { await putJson(claimPath, { by: S.login, at: new Date().toISOString(), stage, project: pid, took_over: c.by || '' }, `接手 ${STAGES[stage]}：${pid}（${S.login}）`, S.tree.sha[claimPath]); } catch { /* 接手失败也照样能看 */ }
    }
  } else if (r.state === 'free' && S.canPush) {
    try {
      await putJson(claimPath, { by: S.login, at: new Date().toISOString(), stage, project: pid }, `认领 ${STAGES[stage]}：${pid}（${S.login}）`);
    } catch (e) {
      if (e.status === 422) { // 刚被别人认领了
        await load();
        const info = S.claimInfo[`${stage}/${pid}`] || {};
        if (info.by && info.by !== S.login) { raced = info.by; toast(`${info.by} 刚刚认领了这一集，你只能看`); }
      } else throw e;
    }
  }
  const iHold = !raced && (r.state === 'free' || r.state === 'mine' || (r.state === 'taken' && isStale(r.claim || {}))); // 这一集的认领在我手上
  if (iHold && r.state !== 'mine' && S.canPush && !S.tree.results[stage][pid]) {
    S.tree.claims[stage][pid] = S.tree.claims[stage][pid] || claimPath; // 认领了：本地先记上，回列表马上就是「我在做」
    S.claimInfo[`${stage}/${pid}`] = { by: S.login, at: new Date().toISOString(), sha: S.tree.sha[claimPath] };
  }
  const task = S.tree.tasks[stage][pid];
  const rowNow = raced ? rows(S.tree, S.desk, S.claimInfo, S.login, stage).find((x) => x.pid === pid) || r : r;
  const lk = lockOf(rowNow, S.login, admins());
  S.current = { stage, pid, pageSha: task.pageSha, metaSha: task.metaSha, row: r, submitted: false, lock: lk };
  setView({ domain: domainOf(r), stage }, push);
  $('list').hidden = true;
  $('task').hidden = false;
  const ep = r.ep || {};
  // 一集讲稿拆成上 / 中 / 下几条片子时标题相同（11-11 试点 69a/b/c）：顶上也带集号、哪一段、第几帧
  const sub = [ep.episode, ep.part && `${ep.part}集`, ep.frames && `第 ${ep.frames} 帧`].filter(Boolean).join(' · ');
  $('tasktitle').textContent = `${STAGES[stage]} · ${ep.title || pid}` + (sub ? `（${sub}）` : '');
  $('taskmsg').textContent = '取页面中…';
  $('release').hidden = !(iHold || lk.canRelease);
  $('release').textContent = iHold ? '放弃认领' : `放掉 ${lk.by || '对方'} 的认领（管理员）`;
  $('clear').hidden = !lk.canClear;
  $('clear').textContent = rowNow.mineDone ? '清空我交的' : `清空 ${rowNow.results.join('、')} 交的（管理员）`;
  $('next').hidden = true;
  freshFrame('');
  const html = await getText(task.page);
  if (!S.current || S.current.pid !== pid || S.current.stage !== stage) return;
  freshFrame(html);
  $('taskmsg').textContent = lk.locked ? lockText(lk) : r.mineDone ? '你交过这一集；再提交会覆盖你那一份（旧的在仓库历史里）' : '填的内容会自动存在这台电脑上，做完点页面最底下的提交按钮';
}

/** 每次换页面都换一个新的框（同一个沙箱框反复换 srcdoc 时，第二个页面会整页画不出来，11-11 实测）；页面先放进去再挂上 */
function freshFrame(html) {
  const old = $('frame');
  const f = document.createElement('iframe');
  for (const a of ['id', 'title', 'sandbox']) f.setAttribute(a, old.getAttribute(a));
  f.srcdoc = html;
  old.replaceWith(f);
}

async function backToList(push = false) {
  S.current = null;
  freshFrame('');
  setView({}, push);
  if (S.tree) renderList();
  await refresh();
}

/** 做完这一集，同一个领域、同一步里接着做下一集 */
function nextOf(cur) {
  const rs = inDomain(rows(S.tree, S.desk, S.claimInfo, S.login, cur.stage), domainOf(cur.row));
  return nextRow(rs, cur.pid);
}
async function goNext() {
  const cur = S.current;
  if (!cur) return;
  await load();
  const n = nextOf(cur);
  if (!n) { toast('这个领域这一步没有别的要做了'); await backToList(); return; }
  S.current = null;
  await openTask(n, false);
}

async function release() {
  if (!S.current) return;
  const { stage, pid } = S.current;
  const path = `claims/${stage}/${pid}.json`;
  try {
    const sha = await shaOf(path);
    if (sha) {
      const c = await getJson(path);
      if (c.by === S.login) await delFile(path, sha, `放弃认领 ${STAGES[stage]}：${pid}（${S.login}）`);
      else if (isAdmin()) await delFile(path, sha, `管理员放掉认领 ${STAGES[stage]}：${pid}（原来是 ${c.by || '?'}，${S.login} 放的）`);
    }
  } catch (e) { toast('没放掉：' + explain(e), 'bad'); return; }
  drafts.del(stage, pid);
  await backToList();
}

/** 清空这一集交上来的东西（11-20 用户定：只有交的人自己能清，管理员谁的都能清）：删提交、放掉认领，这一集回到「没人做」，别人可以重新做。
 *  删掉的那份还在仓库历史里。已经导入流水线的在网页上不清（流水线那边已经用了它）。 */
async function clearSubmitted() {
  const cur = S.current;
  if (!cur) return;
  const { stage, pid } = cur;
  try { await load(); } catch { /* 刷不了就按手上的判 */ }
  const r = rows(S.tree, S.desk, S.claimInfo, S.login, stage).find((x) => x.pid === pid);
  const lk = r ? lockOf(r, S.login, admins()) : null;
  if (!r || !lk || !lk.canClear) { toast('这一集现在清不了：已经导入流水线，或者不是你交的', 'bad'); return; }
  const who = lk.admin ? r.results.slice() : [S.login];
  const mineOnly = who.length === 1 && who[0] === S.login;
  if (!confirm(`${mineOnly ? '清空你交的这一份' : `清空 ${who.join('、')} 交的`}？\n\n清空以后这一集回到「没人做」，别人可以重新做。旧的那份还在仓库历史里，找得回来。`)) return;
  try {
    for (const k of who) {
      const p = `results/${stage}/${pid}/${k}.json`;
      const sha = await shaOf(p);
      if (sha) await delFile(p, sha, `清空提交 ${STAGES[stage]}：${pid}（${k} 交的，${S.login} 清的）`);
    }
    const cp = `claims/${stage}/${pid}.json`;
    const csha = await shaOf(cp);
    if (csha) await delFile(cp, csha, `清空提交后放掉认领 ${STAGES[stage]}：${pid}（${S.login}）`);
  } catch (e) { toast('没清掉：' + explain(e), 'bad'); return; }
  drafts.del(stage, pid);
  delete S.claimInfo[`${stage}/${pid}`];
  toast('清空了，这一集回到「没人做」');
  await backToList();
}

/** 这台电脑上没有草稿、但这一集有人交过：把交上去的那份填回页面（11-20 用户发现：别人点「看看」是空的，看不到提交的人选了什么；自己换一台电脑也一样）。
 *  自己交过看自己的，不然看最晚交的那份；页面在提交之后换过就不填，只在顶上说一声。只是看不算草稿（页面恢复时不往外报改动）。 */
async function showSubmitted(win) {
  const cur = S.current;
  const logins = ((S.tree.results[cur.stage] || {})[cur.pid] || []).slice();
  if (!logins.length) return;
  const got = {};
  await Promise.all(logins.map(async (k) => { try { got[k] = await getJson(`results/${cur.stage}/${cur.pid}/${k}.json`); } catch { /* 取不到的那一份就不看 */ } }));
  if (S.current !== cur) return;
  const [who, res] = resultToShow(got, S.login);
  if (!res) return;
  const mine = who === S.login;
  const name = mine ? '你' : ` ${who} `; // 账号是英文，前后留个空；「你」不用
  const others = Object.keys(got).filter((k) => k !== who);
  const tail = others.length ? `（${others.join('、')} 也交过，这里没显示）` : '';
  const { state, why } = stateOfResult(cur.stage, res, cur.pageSha);
  if (!state) {
    $('taskmsg').textContent = ((why === 'page' ? `${name}${ago(res.at)}交过，但之后页面换了新的，那一份填的内容对不上这一页，没有显示` : `${name}${ago(res.at)}交过；那一份是旧版网页交的，没存页面上填了什么，显示不出来`) + tail).trim();
    return;
  }
  const imported = cur.lock && cur.lock.why === 'imported';
  win.postMessage({ desk: 'restore', state, text: imported ? `这是${name}${ago(res.at)}提交时填的。这一集已经导入流水线，只能看` : mine ? `这是你${ago(res.at)}提交时填的；改了再点提交会覆盖你那一份`
    : `这是 ${who} ${ago(res.at)}提交时填的，你只能看、不能再交。要重做，得 ${who} 自己清空，或者找管理员清空` }, '*');
  $('taskmsg').textContent = `下面是${name}${ago(res.at)}交的` + (mine && !imported ? '' : '，只能看') + tail;
}

// 框里的页面发来的消息：ready（页面起来了：有草稿就发回去填上，没有草稿但有人交过就填交上去的那份）、draft（填的内容变了：存在这台电脑上）、submit（点了提交：写进私有仓库）
window.addEventListener('message', async (ev) => {
  const frame = $('frame');
  if (!S.current || ev.source !== frame.contentWindow) return;
  const d = ev.data || {};
  const { stage, pid } = S.current;
  if (d.desk === 'ready') {
    const dr = drafts.get(stage, pid);
    if (dr && dr.pageSha === S.current.pageSha && dr.state) {
      ev.source.postMessage({ desk: 'restore', state: dr.state, text: dr.submitted ? `这是你上次提交时填的（${ago(dr.at)}）；改了再点提交会覆盖` : `已恢复你${ago(dr.at)}填到一半的内容` }, '*');
      return;
    }
    if (dr) drafts.del(stage, pid); // 页面换过了，旧草稿对不上
    showSubmitted(ev.source).catch(() => {}); // 这台电脑上没有草稿：有人交过就把交上去的那份填回页面
    return;
  }
  if (d.desk === 'draft') {
    const ok = drafts.set(stage, pid, { pageSha: S.current.pageSha, at: new Date().toISOString(), state: d.state, submitted: false });
    S.current.submitted = false;
    $('next').hidden = true;
    $('taskmsg').textContent = ok ? `已自动存在这台电脑上（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）；做完点页面最底下的提交按钮` : '这个浏览器存不了草稿（隐私模式？）：别关这一页，做完直接提交';
    return;
  }
  if (d.desk !== 'submit') return;
  const ack = (ok, text) => ev.source.postMessage({ desk: 'ack', ok, text }, '*');
  if (!payloadOk(stage, pid, d)) return ack(false, '页面和这一集对不上，没有提交：回列表重新打开再试');
  if (!S.canPush) return ack(false, '你的口令没有写权限，交不上：口令的 Contents 要选 Read and write，重新登录');
  // 锁（11-20）：交之前再看一眼仓库——打开以后别人可能已经交了 / 认领了。锁着就不收。
  try { await load(); } catch { /* 刷不了就按打开时的状态判 */ }
  if (!S.current || S.current.pid !== pid || S.current.stage !== stage) return;
  const rowS = rows(S.tree, S.desk, S.claimInfo, S.login, stage).find((x) => x.pid === pid);
  const lkS = rowS ? lockOf(rowS, S.login, admins()) : S.current.lock;
  if (lkS && lkS.locked) { $('taskmsg').textContent = lockText(lkS); return ack(false, lockText(lkS)); }
  const path = `results/${stage}/${pid}/${S.login}.json`;
  const cur = S.current;
  try {
    const sha = await shaOf(path);
    await putJson(path, makeResult(stage, pid, S.login, d.payload, cur, APP, new Date(), d.state || null), `${STAGES[stage]}提交：${pid}（${S.login}）`, sha);
    const tm = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    if (d.state) drafts.set(stage, pid, { pageSha: cur.pageSha, at: new Date().toISOString(), state: d.state, submitted: true });
    if (S.current !== cur) return;
    cur.submitted = true;
    $('release').hidden = true;
    let n = null;
    try { await load(); n = nextOf(cur); } catch { /* 列表刷不了不碍事 */ }
    ack(true, `已提交（${tm}）。${n ? '点上面「下一集 →」接着做；' : ''}想改就改完再点一次，会覆盖你这一份。`);
    $('taskmsg').textContent = `已提交（${tm}）`;
    $('next').hidden = !n;
    if (n) $('next').textContent = `下一集 →  ${(n.ep.title || n.pid).slice(0, 14)}${n.ep.part ? `（${n.ep.part}）` : ''}`;
  } catch (e) {
    ack(false, '没交上：' + explain(e) + '。填的内容还在，别关这页，过一会儿再点一次。');
  }
});

// ---------------------------------------------------------------- 地址栏（刷新、浏览器的后退都落回原处）
async function route() {
  const v = parseHash(location.hash);
  if (v.pid && v.stage && S.tree && S.tree.tasks[v.stage][v.pid]) {
    if (S.current && S.current.pid === v.pid && S.current.stage === v.stage) return;
    const r = rows(S.tree, S.desk, S.claimInfo, S.login, v.stage).find((x) => x.pid === v.pid);
    S.current = null;
    if (r && (r.state === 'mine' || r.mineDone)) { await openTask(r, false); return; } // 只有我自己在做 / 做过的才直接打开（别人的要点了才开，免得一刷新就认领）
  }
  S.current = null;
  freshFrame('');
  if (v.domain) S.domain = v.domain;
  S.stage = v.stage || S.stage;
  if (S.tree) renderList();
  refresh().catch(() => {});
}

// ---------------------------------------------------------------- 启动
async function start() {
  const login = async () => {
    $('loginmsg').textContent = '登录中…';
    try {
      await enter($('repo').value, $('token').value, $('remember').checked);
      $('token').value = '';
      await load();
      await route();
    } catch (e) { showLogin('登录不上：' + (e.status !== undefined ? explain(e) : e.message)); }
  };
  $('enter').addEventListener('click', login);
  $('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  // 11-25：按钮写明是「退出登录」，点了先问一句——有人想回列表点了它，口令被清掉、得回 GitHub 重新找
  $('logout').addEventListener('click', () => {
    if (!confirm('退出登录？\n\n这台电脑上存的口令和没交的草稿都会删掉，下次要重新贴 GitHub 口令。\n\n只是想回列表：点「取消」，再点左上角的「← 回列表」。')) return;
    ls.del('token'); ls.clearDrafts(); S.token = ''; S.current = null; freshFrame(''); showLogin('已退出登录（这台电脑上的口令和草稿都删掉了）');
  });
  $('refresh').addEventListener('click', () => refresh().then(() => toast('刷新好了')).catch((e) => toast('刷新不了：' + explain(e), 'bad')));
  $('back').addEventListener('click', () => backToList(true).catch(() => {}));
  $('next').addEventListener('click', () => goNext().catch((e) => toast('打不开下一集：' + explain(e), 'bad')));
  $('release').addEventListener('click', () => release());
  $('clear').addEventListener('click', () => clearSubmitted());
  window.addEventListener('popstate', () => { if (S.token && S.tree) route().catch(() => {}); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.token && S.tree && !S.current && Date.now() - S.lastRefresh > 20000) refresh().catch(() => {}); });
  const repo = ls.get('repo');
  const token = ls.get('token');
  const q = normRepo(new URLSearchParams(location.search).get('repo') || '');
  if (token && repo && (!q || q === repo)) {
    let remembered = false;
    try { remembered = !!localStorage.getItem('desk.token'); } catch { /* 隐私模式 */ }
    try {
      await enter(repo, token, remembered);
      await load();
      await route();
      return;
    } catch (e) { showLogin('上次的口令用不了：' + explain(e)); return; }
  }
  showLogin();
}
start();
