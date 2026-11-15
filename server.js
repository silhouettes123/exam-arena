'use strict';
/**
 * 抢答星球 · 考试答题平台（管理端 + 用户端）
 * 零依赖 Node 服务：多场考试并行、整场倒计时、题目/选项乱序、交卷后统一阅卷
 * 启动：node server.js   用户端 /   管理端 /admin
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseQuestions, docxToText } = require('./import-parser');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'db.json');
const PORT = process.env.PORT != null ? Number(process.env.PORT) : 8095;

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = p => p + crypto.randomBytes(6).toString('hex');
const now = () => Date.now();

function int(v, min, max, def) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/* ------------------------------------------------------------------ */
/* 数据                                                                */
/* ------------------------------------------------------------------ */
function defaultDb() {
  const q = (cat, text, opts, a, score, explain) => ({
    id: rid('q_'), cat, text, options: opts, correct: a, score,
    explain: explain || '', createdAt: now()
  });
  return {
    settings: { adminPass: sha('admin123') },
    questions: [
      q('科学', '太阳系中体积最大的行星是哪一颗？', ['地球', '木星', '土星', '火星'], 1, 10, '木星是太阳系中体积和质量最大的行星。'),
      q('文学', '《红楼梦》的作者是谁？', ['吴承恩', '罗贯中', '曹雪芹', '施耐庵'], 2, 10, '前八十回曹雪芹著，后四十回一般认为由高鹗整理。'),
      q('科技', '计算机中 1 字节（Byte）等于多少位（bit）？', ['4 位', '8 位', '16 位', '32 位'], 1, 10, '1 Byte = 8 bit。'),
      q('地理', '世界上海拔最高的山峰是？', ['乔戈里峰', '珠穆朗玛峰', '干城章嘉峰', '洛子峰'], 1, 10, '珠穆朗玛峰海拔 8848.86 米。'),
      q('常识', '一年共有多少个节气？', ['12 个', '18 个', '24 个', '36 个'], 2, 10, '二十四节气。')
    ],
    exams: []
  };
}

function normalizeDb(raw) {
  const base = defaultDb();
  const db = {
    settings: Object.assign({}, base.settings, raw && raw.settings),
    questions: Array.isArray(raw && raw.questions) ? raw.questions : base.questions,
    exams: Array.isArray(raw && raw.exams) ? raw.exams : []
  };
  db.questions = db.questions.map(q => ({
    id: q.id || rid('q_'),
    cat: String(q.cat || '未分类').slice(0, 20),
    text: String(q.text || '').slice(0, 500),
    options: (Array.isArray(q.options) ? q.options : []).slice(0, 4).map(o => String(o).slice(0, 200)),
    correct: int(q.correct, 0, 3, 0),
    score: int(q.score, 1, 100, 10),
    explain: String(q.explain || '').slice(0, 400),
    createdAt: q.createdAt || now()
  })).filter(q => q.options.length === 4 && q.text);

  db.exams = db.exams.map(e => ({
    id: e.id || rid('e_'),
    title: String(e.title || '未命名考试').slice(0, 60),
    questionIds: (Array.isArray(e.questionIds) ? e.questionIds : []).filter(id => db.questions.some(q => q.id === id)),
    durationMinutes: int(e.durationMinutes, 1, 600, 10),
    shuffleQuestions: !!e.shuffleQuestions,
    shuffleOptions: !!e.shuffleOptions,
    maxSwitch: int(e.maxSwitch, 0, 99, 0),
    endWhenAllSubmitted: !!e.endWhenAllSubmitted,
    randomCount: int(e.randomCount, 0, 200, 0),
    randomCat: String(e.randomCat || '').slice(0, 20),
    status: e.status === 'ended' ? 'ended' : 'draft',
    createdAt: e.createdAt || now(),
    startedAt: e.startedAt || 0,
    endedAt: e.endedAt || 0,
    results: Array.isArray(e.results) ? e.results : null,
    questionStats: Array.isArray(e.questionStats) ? e.questionStats : null
  }));
  return db;
}

function loadDb() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) throw new Error('no db');
    return normalizeDb(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) {
    const db = defaultDb();
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (err) { /* ignore */ }
    return db;
  }
}

let db = loadDb();
let saveTimer = null;

/* 公网部署：用环境变量强制管理密码（每次启动以它为准） */
if (process.env.ADMIN_PASSWORD) {
  db.settings.adminPass = sha(process.env.ADMIN_PASSWORD);
  saveDb();
}
function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) { /* ignore */ }
  }, 150);
}

/* ------------------------------------------------------------------ */
/* 运行态（多场并行）                                                   */
/* ------------------------------------------------------------------ */
const runtimes = new Map();   // examId -> runtime
const adminTokens = new Set();

function examOf(id) { return db.exams.find(e => e.id === id); }
function questionsOf(exam) { return exam.questionIds.map(id => db.questions.find(q => q.id === id)).filter(Boolean); }
function runtimeOf(examId) { return runtimes.get(examId) || null; }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makePlayer(exam, name) {
  const qs = questionsOf(exam);
  const order = exam.shuffleQuestions ? shuffle(qs.map(q => q.id)) : qs.map(q => q.id);
  const perms = {};
  qs.forEach(q => { perms[q.id] = exam.shuffleOptions ? shuffle([0, 1, 2, 3]) : [0, 1, 2, 3]; });
  return {
    id: rid('p_'), name, score: 0,
    connected: false, res: null, joinedAt: now(),
    submittedAt: 0, forced: false, switchCount: 0,
    order, perms,
    answers: new Map()
  };
}

function playerCorrect(p, q) {
  const chosen = p.answers.get(q.id);
  if (chosen == null) return false;
  const perm = p.perms[q.id] || [0, 1, 2, 3];
  return perm[chosen] === q.correct;
}

function computeScore(exam, p) {
  return questionsOf(exam).reduce((sum, q) => sum + (playerCorrect(p, q) ? q.score : 0), 0);
}

function rankingOf(rt) {
  return [...rt.players.values()]
    .map(p => ({
      id: p.id, name: p.name, score: p.score,
      submittedAt: p.submittedAt, joinedAt: p.joinedAt,
      connected: p.connected, switchCount: p.switchCount
    }))
    .sort((a, b) => b.score - a.score ||
      (a.submittedAt || Number.MAX_SAFE_INTEGER) - (b.submittedAt || Number.MAX_SAFE_INTEGER) ||
      a.joinedAt - b.joinedAt)
    .map((p, i) => Object.assign(p, { rank: i + 1 }));
}

/* --------------------------- 用户态 --------------------------- */
function userState(rt, p) {
  const exam = examOf(rt.examId);
  const qs = questionsOf(exam);
  const ended = rt.phase === 'ended';
  const showQuestions = rt.phase === 'live' || ended;

  const questions = showQuestions ? p.order.map(qid => {
    const q = qs.find(x => x.id === qid);
    if (!q) return null;
    const perm = p.perms[qid] || [0, 1, 2, 3];
    const chosen = p.answers.has(qid) ? p.answers.get(qid) : -1;
    return {
      id: q.id, cat: q.cat, text: q.text, score: q.score,
      options: perm.map(i => q.options[i]),
      chosen,
      correct: ended ? perm.indexOf(q.correct) : null,
      explain: ended ? q.explain : ''
    };
  }).filter(Boolean) : [];

  const rank = rankingOf(rt);
  const me = rank.find(x => x.id === p.id) || { rank: 0, score: p.score };

  return {
    type: 'state',
    serverNow: now(),
    exam: {
      id: exam.id, title: exam.title, phase: rt.phase,
      total: qs.length,
      startedAt: rt.startedAt,
      deadline: rt.deadline,
      durationMinutes: exam.durationMinutes,
      maxSwitch: exam.maxSwitch
    },
    you: {
      name: p.name,
      score: ended ? computeScore(exam, p) : 0,
      rank: me.rank,
      answered: p.answers.size,
      total: qs.length,
      submitted: !!p.submittedAt,
      submittedAt: p.submittedAt,
      switchCount: p.switchCount,
      forced: p.forced,
      correctCount: ended ? qs.filter(q => playerCorrect(p, q)).length : 0
    },
    questions,
    players: rank.map(x => ({
      name: x.name, score: x.score, rank: x.rank,
      submitted: !!x.submittedAt, connected: x.connected
    }))
  };
}

function pushPlayer(rt, p) {
  if (!p.res) return;
  try { p.res.write('data: ' + JSON.stringify(userState(rt, p)) + '\n\n'); } catch (e) { /* ignore */ }
}

function broadcast(rt) {
  for (const p of rt.players.values()) pushPlayer(rt, p);
}

/* --------------------------- 状态机 --------------------------- */
function publishExam(exam) {
  if (runtimeOf(exam.id)) throw new Error('这场考试已经发布过了');
  if (exam.randomCount > 0) {
    const pool = db.questions.filter(q => !exam.randomCat || q.cat === exam.randomCat);
    if (!pool.length) throw new Error('没有符合条件可供抽题的题目');
    exam.questionIds = shuffle(pool.map(q => q.id)).slice(0, Math.min(exam.randomCount, pool.length));
  }
  exam.status = 'draft';
  exam.startedAt = 0;
  exam.endedAt = 0;
  exam.results = null;
  exam.questionStats = null;
  runtimes.set(exam.id, {
    examId: exam.id, phase: 'lobby',
    startedAt: 0, deadline: 0,
    players: new Map(), createdAt: now(), lastSubmitAt: 0
  });
  saveDb();
}

function startExam(exam) {
  const rt = runtimeOf(exam.id);
  if (!rt) throw new Error('请先发布考试');
  if (rt.phase !== 'lobby') throw new Error('考试已经开始');
  const qs = questionsOf(exam);
  if (!qs.length) throw new Error('这场考试还没有题目');

  rt.phase = 'live';
  rt.startedAt = now();
  rt.deadline = rt.startedAt + exam.durationMinutes * 60 * 1000;
  exam.status = 'live';
  exam.startedAt = rt.startedAt;
  saveDb();
  broadcast(rt);
}

function endExam(exam) {
  const rt = runtimeOf(exam.id);
  if (!rt) throw new Error('考试未开始');
  if (rt.phase === 'ended') return;

  const qs = questionsOf(exam);
  const endAt = rt.deadline || now();
  for (const p of rt.players.values()) {
    if (!p.submittedAt) p.submittedAt = endAt;
    p.score = computeScore(exam, p);
  }

  const rank = rankingOf(rt);
  exam.results = rank.map(p => ({
    rank: p.rank, name: p.name, score: p.score,
    correctCount: qs.filter(q => {
      const pl = rt.players.get(p.id);
      return pl && playerCorrect(pl, q);
    }).length,
    totalMs: Math.max(0, (p.submittedAt || now()) - rt.startedAt)
  }));

  exam.questionStats = qs.map((q, i) => {
    let answered = 0, correct = 0;
    for (const p of rt.players.values()) {
      if (p.answers.has(q.id)) {
        answered++;
        if (playerCorrect(p, q)) correct++;
      }
    }
    return {
      index: i, text: q.text, cat: q.cat, score: q.score,
      answered, correct, accuracy: answered ? Math.round(correct / answered * 100) : 0
    };
  });

  rt.phase = 'ended';
  exam.status = 'ended';
  exam.endedAt = now();
  saveDb();
  broadcast(rt);
}

function resetExam(exam) {
  const rt = runtimeOf(exam.id);
  if (rt) {
    for (const p of rt.players.values()) {
      if (p.res) { try { p.res.end(); } catch (e) { /* ignore */ } p.res = null; }
    }
    runtimes.delete(exam.id);
  }
  exam.status = 'draft';
  exam.startedAt = 0;
  exam.endedAt = 0;
  exam.results = null;
  exam.questionStats = null;
  saveDb();
}

/* 每秒巡检：到时自动收卷 */
setInterval(() => {
  const t = now();
  for (const rt of runtimes.values()) {
    if (rt.phase !== 'live') continue;
    const exam = examOf(rt.examId);
    if (!exam) continue;
    if (rt.deadline && t >= rt.deadline) { endExam(exam); continue; }
    if (exam.endWhenAllSubmitted) {
      const players = [...rt.players.values()];
      if (players.length && players.every(p => p.submittedAt)) {
        if (!rt.lastSubmitAt) rt.lastSubmitAt = t;
        if (t - rt.lastSubmitAt > 15000) endExam(exam);
      } else {
        rt.lastSubmitAt = 0;
      }
    }
  }
}, 1000);

/* ------------------------------------------------------------------ */
/* HTTP 基础                                                           */
/* ------------------------------------------------------------------ */
function send(res, status, data, headers) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(body);
}

function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > 8 * 1024 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch (e) { cb(null); }
  });
  req.on('error', () => cb(null));
}

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function isAdmin(req) {
  const c = cookies(req);
  return !!(c.qadmin && adminTokens.has(c.qadmin));
}
function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  send(res, 401, { error: '请先登录管理端' });
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  const safe = path.normalize(rel).replace(/^([/\\])+/, '');
  let file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) {
    const flat = path.join(ROOT, safe);
    const ext = path.extname(flat).toLowerCase();
    const FLAT_OK = { '.html': 1, '.txt': 1, '.ico': 1, '.png': 1, '.svg': 1, '.xml': 1 };
    file = (FLAT_OK[ext] && safe.indexOf('..') < 0 && fs.existsSync(flat)) ? flat : '';
  }
  if (!file) { send(res, 404, '404 Not Found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, '404 Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* 用户端 API                                                          */
/* ------------------------------------------------------------------ */
function handlePublic(req, res) {
  const list = [];
  for (const exam of db.exams) {
    const rt = runtimeOf(exam.id);
    if (!rt) continue;
    list.push({
      id: exam.id, title: exam.title, phase: rt.phase,
      players: rt.players.size, total: questionsOf(exam).length,
      deadline: rt.deadline, serverNow: now(),
      durationMinutes: exam.durationMinutes
    });
  }
  send(res, 200, { exams: list, hasQuestions: db.questions.length });
}

function findPlayer(token) {
  for (const rt of runtimes.values()) {
    if (rt.players.has(token)) return { rt, p: rt.players.get(token) };
  }
  return null;
}

function handleJoin(req, res) {
  readBody(req, body => {
    if (!body) return send(res, 400, { error: '请求格式错误' });

    const token = String(body.token || '');
    if (token) {
      const found = findPlayer(token);
      if (found) {
        found.p.connected = true;
        send(res, 200, { token, name: found.p.name, examId: found.rt.examId, resumed: true });
        pushPlayer(found.rt, found.p);
        broadcast(found.rt);
        return;
      }
    }

    const exam = examOf(String(body.examId || ''));
    if (!exam) return send(res, 404, { error: '考试不存在' });
    const rt = runtimeOf(exam.id);
    if (!rt) return send(res, 409, { error: '这场考试还没有发布' });
    if (rt.phase === 'ended') return send(res, 409, { error: '这场考试已经结束' });
    if (rt.phase === 'live' && rt.deadline && now() >= rt.deadline) return send(res, 409, { error: '考试已到结束时间' });

    const name = String(body.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
    if (!name) return send(res, 400, { error: '请输入名字' });
    if ([...rt.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return send(res, 409, { error: '这个昵称已被占用，换一个吧' });
    }

    const p = makePlayer(exam, name);
    rt.players.set(p.id, p);
    send(res, 200, { token: p.id, name: p.name, examId: exam.id, resumed: false });
    broadcast(rt);
  });
}

function handleStream(req, res, url) {
  const found = findPlayer(url.searchParams.get('token') || '');
  if (!found) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 1500\n\n: connected\n\n');

  const { rt, p } = found;
  p.res = res;
  p.connected = true;
  pushPlayer(rt, p);
  broadcast(rt);

  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 20000);
  req.on('close', () => {
    clearInterval(hb);
    if (p.res === res) p.res = null;
    p.connected = false;
    broadcast(rt);
  });
}

function handleAnswer(req, res) {
  readBody(req, body => {
    if (!body) return send(res, 400, { error: '请求格式错误' });
    const found = findPlayer(String(body.token || ''));
    if (!found) return send(res, 404, { error: '请先进入考场' });
    const { rt, p } = found;
    if (rt.phase !== 'live') return send(res, 409, { error: '当前不在考试时间' });
    if (p.submittedAt) return send(res, 409, { error: '你已交卷，不能再修改' });
    if (rt.deadline && now() > rt.deadline + 1000) return send(res, 409, { error: '考试时间已结束' });

    const exam = examOf(rt.examId);
    const q = questionsOf(exam).find(x => x.id === body.qid);
    if (!q) return send(res, 404, { error: '题目不存在' });
    if (p.order.indexOf(q.id) < 0) return send(res, 400, { error: '题目不在你的试卷中' });

    const choice = Number(body.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return send(res, 400, { error: '选项无效' });

    p.answers.set(q.id, choice);
    pushPlayer(rt, p);
    send(res, 200, { ok: true, answered: p.answers.size });
  });
}

function handleSubmit(req, res) {
  readBody(req, body => {
    const found = findPlayer(String((body && body.token) || ''));
    if (!found) return send(res, 404, { error: '请先进入考场' });
    const { rt, p } = found;
    if (rt.phase !== 'live') return send(res, 409, { error: '当前不在考试时间' });
    if (p.submittedAt) return send(res, 200, { ok: true, already: true });
    p.submittedAt = now();
    pushPlayer(rt, p);
    broadcast(rt);
    send(res, 200, { ok: true, answered: p.answers.size });
  });
}

function handleSwitch(req, res) {
  readBody(req, body => {
    const found = findPlayer(String((body && body.token) || ''));
    if (!found) return send(res, 404, { error: '请先进入考场' });
    const { rt, p } = found;
    if (rt.phase !== 'live' || p.submittedAt) return send(res, 200, { ok: true, ignored: true });
    p.switchCount += 1;
    const exam = examOf(rt.examId);
    if (exam.maxSwitch > 0 && p.switchCount >= exam.maxSwitch && !p.submittedAt) {
      p.submittedAt = now();
      p.forced = true;
    }
    pushPlayer(rt, p);
    broadcast(rt);
    send(res, 200, { ok: true, switchCount: p.switchCount, forced: p.forced });
  });
}

/* ------------------------------------------------------------------ */
/* 管理端 API                                                          */
/* ------------------------------------------------------------------ */
function examStatus(exam) {
  const rt = runtimeOf(exam.id);
  if (!rt) return exam.status === 'ended' ? 'ended' : 'draft';
  return rt.phase;
}

function adminOverview() {
  const rtList = [];
  for (const exam of db.exams) {
    const rt = runtimeOf(exam.id);
    if (!rt) continue;
    const qs = questionsOf(exam);
    const players = [...rt.players.values()].map(p => ({
      name: p.name,
      answered: p.answers.size,
      total: qs.length,
      submitted: !!p.submittedAt,
      switchCount: p.switchCount,
      forced: p.forced,
      score: rt.phase === 'ended' ? computeScore(exam, p) : null,
      connected: p.connected
    })).sort((a, b) => (b.score || 0) - (a.score || 0));

    rtList.push({
      examId: exam.id, title: exam.title, phase: rt.phase,
      startedAt: rt.startedAt, deadline: rt.deadline, serverNow: now(),
      total: qs.length, players,
      submittedCount: players.filter(p => p.submitted).length,
      avgAnswered: players.length ? Math.round(players.reduce((a, p) => a + p.answered, 0) / players.length) : 0
    });
  }

  return {
    authed: true,
    questions: db.questions,
    exams: db.exams.map(e => ({
      id: e.id, title: e.title, status: examStatus(e),
      questionIds: e.questionIds, count: e.questionIds.length,
      durationMinutes: e.durationMinutes,
      shuffleQuestions: e.shuffleQuestions,
      shuffleOptions: e.shuffleOptions,
      maxSwitch: e.maxSwitch,
      endWhenAllSubmitted: e.endWhenAllSubmitted,
      randomCount: e.randomCount || 0,
      randomCat: e.randomCat || '',
      createdAt: e.createdAt,
      results: e.results,
      questionStats: e.questionStats
    })),
    runtimes: rtList
  };
}

function handleAdminOverview(req, res) {
  if (!requireAdmin(req, res)) return;
  send(res, 200, adminOverview());
}

function handleAdminLogin(req, res) {
  readBody(req, body => {
    if (!body) return send(res, 400, { error: '请求格式错误' });
    if (sha(body.password || '') !== db.settings.adminPass) return send(res, 401, { error: '密码错误' });
    const token = crypto.randomBytes(18).toString('hex');
    adminTokens.add(token);
    send(res, 200, { ok: true }, {
      'Set-Cookie': 'qadmin=' + token + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200'
    });
  });
}

function handleAdminLogout(req, res) {
  const c = cookies(req);
  if (c.qadmin) adminTokens.delete(c.qadmin);
  send(res, 200, { ok: true }, { 'Set-Cookie': 'qadmin=; HttpOnly; Path=/; Max-Age=0' });
}

function handleImportPreview(req, res) {
  if (!requireAdmin(req, res)) return;
  readBody(req, body => {
    if (!body) return send(res, 400, { error: '请求格式错误' });
    let text = '';
    try {
      if (body.docx) text = docxToText(Buffer.from(String(body.docx), 'base64'));
      else text = String(body.text || '');
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    if (!text.trim()) return send(res, 400, { error: '没有解析到文字内容' });
    const result = parseQuestions(text, { cat: body.cat || '导入题目', score: int(body.score, 1, 100, 10) });
    send(res, 200, {
      questions: result.questions,
      warnings: result.warnings,
      total: result.total,
      chars: text.length
    });
  });
}

function handleImportCommit(req, res) {
  if (!requireAdmin(req, res)) return;
  readBody(req, body => {
    const list = Array.isArray(body && body.questions) ? body.questions : [];
    if (!list.length) return send(res, 400, { error: '没有可导入的题目' });
    let added = 0, skipped = 0;
    const existing = new Set(db.questions.map(q => q.text.trim()));
    for (const item of list) {
      const text = String(item.text || '').trim().slice(0, 500);
      const options = (Array.isArray(item.options) ? item.options : []).map(o => String(o || '').trim().slice(0, 200));
      const correct = int(item.correct, 0, 3, -1);
      if (!text || options.length !== 4 || options.some(o => !o) || correct < 0) { skipped++; continue; }
      if (existing.has(text)) { skipped++; continue; }
      db.questions.push({
        id: rid('q_'),
        cat: String(item.cat || '导入题目').trim().slice(0, 20) || '导入题目',
        text, options, correct,
        score: int(item.score, 1, 100, 10),
        explain: String(item.explain || '').slice(0, 400),
        createdAt: now()
      });
      existing.add(text);
      added++;
    }
    saveDb();
    send(res, 200, Object.assign(adminOverview(), { added, skipped }));
  });
}
function handleQuestionSave(req, res) {
  if (!requireAdmin(req, res)) return;
  readBody(req, body => {
    const text = String((body && body.text) || '').trim().slice(0, 500);
    const options = (Array.isArray(body && body.options) ? body.options : []).map(o => String(o || '').trim().slice(0, 200));
    if (!text) return send(res, 400, { error: '题干不能为空' });
    if (options.length !== 4 || options.some(o => !o)) return send(res, 400, { error: '四个选项都要填写' });
    const correct = int(body.correct, 0, 3, -1);
    if (correct < 0) return send(res, 400, { error: '请选择正确答案' });

    const data = {
      cat: String(body.cat || '未分类').trim().slice(0, 20) || '未分类',
      text, options, correct,
      score: int(body.score, 1, 100, 10),
      explain: String(body.explain || '').slice(0, 400)
    };
    if (body.id) {
      const q = db.questions.find(x => x.id === body.id);
      if (!q) return send(res, 404, { error: '题目不存在' });
      Object.assign(q, data);
    } else {
      db.questions.push(Object.assign({ id: rid('q_'), createdAt: now() }, data));
    }
    saveDb();
    send(res, 200, adminOverview());
  });
}

function handleQuestionDelete(req, res, url) {
  if (!requireAdmin(req, res)) return;
  const id = url.searchParams.get('id');
  for (const rt of runtimes.values()) {
    if (rt.phase !== 'ended' && questionsOf(examOf(rt.examId)).some(q => q.id === id)) {
      return send(res, 409, { error: '这道题正在被进行中的考试使用' });
    }
  }
  const before = db.questions.length;
  db.questions = db.questions.filter(q => q.id !== id);
  if (db.questions.length === before) return send(res, 404, { error: '题目不存在' });
  db.exams.forEach(e => { e.questionIds = e.questionIds.filter(x => x !== id); });
  saveDb();
  send(res, 200, adminOverview());
}

function handleExamSave(req, res) {
  if (!requireAdmin(req, res)) return;
  readBody(req, body => {
    const title = String((body && body.title) || '').trim().slice(0, 60);
    if (!title) return send(res, 400, { error: '考试名称不能为空' });
    const randomCount = int(body.randomCount, 0, 200, 0);
    const randomCat = String(body.randomCat || '').trim().slice(0, 20);
    const ids = (Array.isArray(body.questionIds) ? body.questionIds : []).filter(id => db.questions.some(q => q.id === id));
    if (!randomCount && !ids.length) return send(res, 400, { error: '至少选择一道题，或设置随机抽取数量' });

    const data = {
      title, questionIds: ids,
      durationMinutes: int(body.durationMinutes, 1, 600, 10),
      shuffleQuestions: !!body.shuffleQuestions,
      shuffleOptions: !!body.shuffleOptions,
      maxSwitch: int(body.maxSwitch, 0, 99, 0),
      endWhenAllSubmitted: !!body.endWhenAllSubmitted,
      randomCount,
      randomCat
    };

    if (body.id) {
      const exam = examOf(body.id);
      if (!exam) return send(res, 404, { error: '考试不存在' });
      const rt = runtimeOf(exam.id);
      if (rt && rt.phase !== 'ended') return send(res, 409, { error: '进行中的考试不能修改' });
      Object.assign(exam, data);
    } else {
      db.exams.push(Object.assign({
        id: rid('e_'), status: 'draft', createdAt: now(),
        startedAt: 0, endedAt: 0, results: null, questionStats: null
      }, data));
    }
    saveDb();
    send(res, 200, adminOverview());
  });
}

function handleExamDelete(req, res, url) {
  if (!requireAdmin(req, res)) return;
  const id = url.searchParams.get('id');
  const rt = runtimeOf(id);
  if (rt && rt.phase !== 'ended') return send(res, 409, { error: '进行中的考试不能删除' });
  if (rt) runtimes.delete(id);
  const before = db.exams.length;
  db.exams = db.exams.filter(e => e.id !== id);
  if (db.exams.length === before) return send(res, 404, { error: '考试不存在' });
  saveDb();
  send(res, 200, adminOverview());
}

function handleExamAction(req, res, action) {
  if (!requireAdmin(req, res)) return;
  readBody(req, body => {
    const exam = examOf(body && body.id);
    try {
      if (!exam) throw new Error('考试不存在');
      if (action === 'publish') publishExam(exam);
      else if (action === 'start') startExam(exam);
      else if (action === 'end') endExam(exam);
      else if (action === 'reset') resetExam(exam);
      else throw new Error('未知操作');
      send(res, 200, adminOverview());
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  });
}

function handleAdminPassword(req, res) {
  if (!requireAdmin(req, res)) return;
  readBody(req, body => {
    if (sha((body && body.oldPassword) || '') !== db.settings.adminPass) return send(res, 401, { error: '原密码不正确' });
    const np = String((body && body.newPassword) || '');
    if (np.length < 4) return send(res, 400, { error: '新密码至少 4 位' });
    db.settings.adminPass = sha(np);
    saveDb();
    send(res, 200, { ok: true });
  });
}

function handleExport(req, res, url) {
  if (!requireAdmin(req, res)) return;
  const exam = examOf(url.searchParams.get('id'));
  if (!exam || !exam.results) return send(res, 404, { error: '没有可导出的成绩' });
  const lines = ['排名,昵称,总分,答对题数,用时(秒)'];
  exam.results.forEach(r => lines.push([r.rank, r.name, r.score, r.correctCount, (r.totalMs / 1000).toFixed(1)].join(',')));
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="result-' + exam.id + '.csv"',
    'Cache-Control': 'no-store'
  });
  res.end('\ufeff' + lines.join('\r\n'));
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname, m = req.method;

  try {
    if (m === 'GET' && p === '/healthz') return send(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    if (m === 'GET' && p === '/api/public') return handlePublic(req, res);
    if (m === 'POST' && p === '/api/join') return handleJoin(req, res);
    if (m === 'GET' && p === '/api/stream') return handleStream(req, res, url);
    if (m === 'POST' && p === '/api/answer') return handleAnswer(req, res);
    if (m === 'POST' && p === '/api/submit') return handleSubmit(req, res);
    if (m === 'POST' && p === '/api/switch') return handleSwitch(req, res);

    if (m === 'POST' && p === '/api/admin/login') return handleAdminLogin(req, res);
    if (m === 'POST' && p === '/api/admin/logout') return handleAdminLogout(req, res);
    if (m === 'GET' && p === '/api/admin/overview') return handleAdminOverview(req, res);
    if (m === 'POST' && p === '/api/admin/question') return handleQuestionSave(req, res);
    if (m === 'POST' && p === '/api/admin/import/preview') return handleImportPreview(req, res);
    if (m === 'POST' && p === '/api/admin/import/commit') return handleImportCommit(req, res);
    if (m === 'DELETE' && p === '/api/admin/question') return handleQuestionDelete(req, res, url);
    if (m === 'POST' && p === '/api/admin/exam') return handleExamSave(req, res);
    if (m === 'DELETE' && p === '/api/admin/exam') return handleExamDelete(req, res, url);
    if (m === 'GET' && p === '/api/admin/export') return handleExport(req, res, url);
    if (m === 'POST' && p === '/api/admin/password') return handleAdminPassword(req, res);
    if (m === 'POST' && p.indexOf('/api/admin/exam/') === 0) {
      return handleExamAction(req, res, p.replace('/api/admin/exam/', ''));
    }

    if (m === 'GET') return serveStatic(res, p);
    send(res, 405, { error: 'Method Not Allowed' });
  } catch (err) {
    send(res, 500, { error: err.message || '服务器错误' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('考试平台已启动  用户端 http://127.0.0.1:' + PORT + '/   管理端 http://127.0.0.1:' + PORT + '/admin');
});

module.exports = { server };







