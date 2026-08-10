/**
 * Diff 内容缓存
 *
 * key 格式：`${taskId}:${filePath}:${mtimeMs}`
 * - filePath：绝对路径
 * - mtimeMs：文件最后修改时间（毫秒），文件有改动时缓存自动失效
 *
 * 最大条目数：MAX_SIZE（超出时淘汰最旧条目，简单 FIFO）
 */

import fs from 'node:fs';

const MAX_SIZE = 300;

// key → { content: string, insertedAt: number }
const store = new Map();

function makeKey(taskId, filePath, mtimeMs) {
  return `${taskId}:${filePath}:${mtimeMs}`;
}

/**
 * 读取文件当前的 mtime（用于构造 key 并校验缓存有效性）
 * 文件不存在时返回 0（缓存不命中）
 */
export function getMtime(filePath) {
  try { return fs.statSync(filePath).mtimeMs; }
  catch { return 0; }
}

/**
 * 尝试命中缓存
 * @returns {string|null} diff 内容，未命中返回 null
 */
export function getCache(taskId, filePath) {
  const mtime = getMtime(filePath);
  if (!mtime) return null;
  const key = makeKey(taskId, filePath, mtime);
  const entry = store.get(key);
  return entry ? entry.content : null;
}

/**
 * 写入缓存（FIFO 淘汰旧条目）
 */
export function setCache(taskId, filePath, content) {
  const mtime = getMtime(filePath);
  if (!mtime) return;
  const key = makeKey(taskId, filePath, mtime);
  if (store.size >= MAX_SIZE) {
    // 淘汰最旧的条目
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
  store.set(key, { content, insertedAt: Date.now() });
}

/** 清除某任务的全部缓存（任务删除/归档时调用） */
export function clearTask(taskId) {
  for (const k of store.keys()) {
    if (k.startsWith(`${taskId}:`)) store.delete(k);
  }
}

export function cacheSize() { return store.size; }
