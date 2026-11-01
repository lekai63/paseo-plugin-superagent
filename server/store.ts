import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { emptyState, SuperagentStateSchema, type SuperagentState } from "../shared/model";

/** 关闭态历史保留上限;活跃队列(pending/running)永不裁剪。 */
const MAX_TRIGGERS = 300;
const MAX_DECISIONS = 200;
const MAX_CLOSED_THREADS = 40;

/**
 * 解析宿主 daemon 的 PASEO_HOME(与 Paseo 自身一致:环境变量优先,支持 `~` 展开)。
 */
export function resolvePaseoHome(): string {
  const configured = process.env.PASEO_HOME?.trim();
  const expanded = configured
    ? configured.startsWith("~/")
      ? path.join(homedir(), configured.slice(2))
      : configured === "~"
        ? homedir()
        : configured
    : null;
  return path.resolve(expanded ?? path.join(homedir(), ".paseo"));
}

/** 状态文件路径:`$PASEO_HOME/plugin-data/superagent/state.json`。 */
export function stateFilePath(): string {
  return path.join(resolvePaseoHome(), "plugin-data", "superagent", "state.json");
}

type Mutator = (state: SuperagentState) => void;

/**
 * 原子 JSON 持久化 + 串行写队列。
 * 所有变更经 `update()` 落盘后才执行副作用,崩溃后由看门狗对账恢复。
 */
export class SuperagentStore {
  private state: SuperagentState = emptyState();
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;
  /** 首次加载 promise:所有读状态的引擎路径都必须先 await 它,避免与磁盘加载竞态。 */
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.load();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    let raw: string;
    try {
      raw = await readFile(stateFilePath(), "utf-8");
    } catch {
      this.loaded = true;
      return;
    }
    try {
      const parsed = SuperagentStateSchema.parse(JSON.parse(raw));
      this.state = parsed;
    } catch (error) {
      console.error("[superagent] state file invalid, starting empty", error);
      this.state = emptyState();
    }
    this.loaded = true;
  }

  /** 当前状态(浅拷贝防御调用方误改;引擎内部经 update 修改)。 */
  get(): SuperagentState {
    return this.state;
  }

  /**
   * 串行变更:mutator 同步修改 state → 裁剪 → 原子落盘。
   * 变更后的最新状态在返回值里给出,便于副作用读取刚写入的实体。
   */
  update(mutator: Mutator): Promise<SuperagentState> {
    const next = { ...this.state };
    mutator(next);
    trim(next);
    this.state = next;
    this.writeChain = this.writeChain
      .then(() => persist(next))
      .catch((error) => {
        console.error("[superagent] state persist failed", error);
      });
    return this.writeChain.then(() => this.state);
  }

  /** 只改内存不落盘(仅限恢复流程中已确认存在的一致性修补)。 */
  patchInMemory(mutator: Mutator): void {
    const next = { ...this.state };
    mutator(next);
    this.state = next;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }
}

async function persist(state: SuperagentState): Promise<void> {
  const file = stateFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp, file);
}

function trim(state: SuperagentState): void {
  if (state.triggers.length > MAX_TRIGGERS) {
    const keep = state.triggers.filter((t) => t.status === "pending");
    const done = state.triggers
      .filter((t) => t.status !== "pending")
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, MAX_TRIGGERS - keep.length);
    state.triggers = [...keep, ...done];
  }
  if (state.decisions.length > MAX_DECISIONS) {
    state.decisions = state.decisions
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_DECISIONS);
  }
  const closed = state.threads
    .filter((t) => t.state === "closed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (closed.length > MAX_CLOSED_THREADS) {
    const drop = new Set(closed.slice(MAX_CLOSED_THREADS).map((t) => t.id));
    state.threads = state.threads.filter((t) => !drop.has(t.id));
    state.tickets = state.tickets.filter((tk) => !drop.has(tk.threadId));
    state.triggers = state.triggers.filter((tr) => !tr.threadId || !drop.has(tr.threadId));
    state.decisions = state.decisions.filter((d) => !drop.has(d.threadId));
  }
}
