/**
 * lib/lastworkspace.js — 记住最近使用的工作区（host 侧，跨页面端口/来源变化）
 *
 * 面板原先把工作区存在浏览器 localStorage，但 DSH 每次重启端口会变，
 * localStorage 按来源隔离，于是看起来「工作区丢了、数据看不见」。
 * 这里把最近工作区存到 DSH_HOME 下，由数据通道在每次请求时记下、面板首次打开时取回。
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const DIR = path.join(HOME, 'dsh-paper-agent');
const FILE = path.join(DIR, 'state.json');

export async function loadLastState() {
  try {
    const raw = JSON.parse(await readFile(FILE, 'utf8'));
    return raw !== null && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export async function loadLastWorkspace() {
  const state = await loadLastState();
  return typeof state.lastWorkspace === 'string' && state.lastWorkspace.trim() !== '' ? state.lastWorkspace.trim() : null;
}

export async function rememberWorkspace(workspace) {
  if (typeof workspace !== 'string' || workspace.trim() === '') return;
  const state = await loadLastState();
  const next = { ...state, lastWorkspace: path.resolve(workspace.trim()), updatedAt: new Date().toISOString() };
  await mkdir(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await rename(tmp, FILE);
}
