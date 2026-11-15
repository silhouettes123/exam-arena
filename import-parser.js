'use strict';
/**
 * 题库导入解析器：把"粘贴的文本"或 Word(.docx) 转成题目数组。
 * 零依赖：docx 本质是 zip，这里用 zlib 手动解出 word/document.xml。
 */
const zlib = require('zlib');

/* ---------------- 文本规范化 ---------------- */
function normalize(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/* ---------------- 解析题目 ---------------- */
function parseQuestions(raw, opts) {
  const defaults = Object.assign({ cat: '导入题目', score: 10 }, opts || {});
  const text = normalize(raw);
  const lines = text.split('\n');

  const blocks = [];
  let cur = [];
  const isStart = l => /^\s*(?:\d{1,3}\s*[.、．)）]|第\s*\d+\s*题)/.test(l);

  for (const line of lines) {
    if (!line.trim()) {
      if (cur.length) { blocks.push(cur); cur = []; }
      continue;
    }
    if (isStart(line) && cur.length) { blocks.push(cur); cur = []; }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur);

  const questions = [];
  const warnings = [];

  blocks.forEach((blockLines, bi) => {
    let body = blockLines.join('\n');

    // 答案
    const ansMatch = body.match(/(?:正确答案|参考答案|答案|Answer)\s*[:：]?\s*([A-Da-d])\b/);
    let correct = -1;
    if (ansMatch) {
      correct = 'ABCD'.indexOf(ansMatch[1].toUpperCase());
      body = body.replace(ansMatch[0], ' ');
    }

    // 解析
    let explain = '';
    const exMatch = body.match(/(?:解析|说明)\s*[:：]\s*([^\n]*)/);
    if (exMatch) {
      explain = exMatch[1].trim();
      body = body.replace(exMatch[0], ' ');
    }

    // 分值
    let score = defaults.score;
    const scoreMatch = body.match(/[（(]\s*(\d{1,3})\s*分\s*[)）]/) || body.match(/分值\s*[:：]\s*(\d{1,3})/);
    if (scoreMatch) {
      score = Math.max(1, Math.min(100, Number(scoreMatch[1]) || defaults.score));
      body = body.replace(scoreMatch[0], ' ');
    }

    // 分类
    let cat = defaults.cat;
    const catMatch = body.match(/【([^】]{1,20})】/) || body.match(/分类\s*[:：]\s*([^\n]{1,20})/);
    if (catMatch) {
      cat = catMatch[1].trim();
      body = body.replace(catMatch[0], ' ');
    }

    // 选项标记 A. / B、 / C） / D:
    const re = /(?:^|[\s])([A-D])\s*[.、．)）:：]\s*/g;
    const marks = [];
    let m;
    while ((m = re.exec(body))) {
      marks.push({ letter: m[1], index: m.index + m[0].indexOf(m[1]), end: re.lastIndex });
    }

    // 只保留 A→B→C→D 依次出现的标记，避免题干里的“维生素A.”误判
    const picked = [];
    const need = ['A', 'B', 'C', 'D'];
    for (const mk of marks) {
      if (picked.length < 4 && mk.letter === need[picked.length]) picked.push(mk);
      if (picked.length === 4) break;
    }

    if (picked.length < 4) {
      warnings.push('第 ' + (bi + 1) + ' 段：只找到 ' + picked.length + ' 个选项，已跳过（需要 A/B/C/D 四个）');
      return;
    }

    let stem = body.slice(0, picked[0].index).replace(/\s+/g, ' ').trim();
    stem = stem.replace(/^\s*(?:\d{1,3}\s*[.、．)）]|第\s*\d+\s*题[.、．:：]?)\s*/, '').trim();

    if (!stem) {
      warnings.push('第 ' + (bi + 1) + ' 段：没有题干，已跳过');
      return;
    }

    const options = [];
    for (let i = 0; i < 4; i++) {
      const start = picked[i].end;
      const end = i + 1 < picked.length ? picked[i + 1].index : body.length;
      options.push(body.slice(start, end).replace(/\s+/g, ' ').trim());
    }

    if (options.some(o => !o)) {
      warnings.push('第 ' + (bi + 1) + ' 段：有选项为空，已跳过');
      return;
    }

    if (correct < 0) {
      warnings.push('第 ' + (bi + 1) + ' 段：没找到“答案：X”，已跳过');
      return;
    }

    questions.push({
      cat: cat.slice(0, 20),
      text: stem.slice(0, 500),
      options: options.map(o => o.slice(0, 200)),
      correct,
      score,
      explain: explain.slice(0, 400)
    });
  });

  return { questions, warnings, total: blocks.length };
}

/* ---------------- docx → 纯文本 ---------------- */
function docxToText(buf) {
  if (!buf || buf.length < 100) throw new Error('文件内容为空');

  // 找 zip 目录结尾标记 EOCD
  let eocd = -1;
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 .docx 文件（旧的 .doc 请另存为 .docx）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  let p = cdOffset;
  let target = null;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === 'word/document.xml') target = { method, compSize, size, localOffset };
    p += 46 + nameLen + extraLen + commentLen;
  }

  if (!target) throw new Error('这个 .docx 里没有正文（word/document.xml）');

  const lo = target.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('docx 文件损坏');
  const lNameLen = buf.readUInt16LE(lo + 26);
  const lExtraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + lNameLen + lExtraLen;
  const data = buf.slice(dataStart, dataStart + (target.compSize || target.size));

  let xml;
  if (target.method === 0) xml = data.toString('utf8');
  else if (target.method === 8) xml = zlib.inflateRawSync(data).toString('utf8');
  else throw new Error('不支持的压缩方式：' + target.method);

  return xmlToText(xml);
}

function xmlToText(xml) {
  const paras = [];
  const re = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(xml))) {
    let p = m[0];
    p = p.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n');
    p = p.replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, '$1');
    p = p.replace(/<[^>]+>/g, '');
    p = decodeXml(p).replace(/[ \t]+$/gm, '');
    paras.push(p);
  }
  return paras.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

module.exports = { parseQuestions, docxToText };
