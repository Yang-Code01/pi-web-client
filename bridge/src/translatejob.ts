/**
 * 翻译任务表（D241）。一次翻译是个几十秒到几分钟的活，页面不该被 HTTP 请求拴住：
 * `start` 立刻返回 id，之后 `/api/translate/job` 轮询进度，`/api/translate/doc` 取译文。
 *
 * 边翻边落盘：每完成一节就把缓存写一遍，页面因此能看到「已经翻好的节」一格格填上来，
 * 中途取消或失败也留得下已经花钱买到的部分。
 */
import { randomUUID } from "node:crypto";

import {
  type TrDoc,
  type TrLang,
  type TrRun,
  type TrRunner,
  type TrSection,
  cutSections,
  readDoc,
  translateDoc,
  writeDoc,
} from "./translate.ts";

export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface JobView {
  id: string;
  status: JobStatus;
  lang: TrLang;
  provider: string;
  model: string;
  /** 已经完成的节数 / 总节数。 */
  done: number;
  total: number;
  /** 正在翻的那一节（标题行，或「开头」）。 */
  note: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface Job extends JobView {
  doc: TrDoc;
  signal: { aborted: boolean };
}

/** 只留最近这些任务；页面一般只轮询手上那一个。 */
const MAX_JOBS = 12;

export class TranslateJobs {
  private jobs = new Map<string, Job>();

  start(input: { text: string; abs: string; rel: string; lang: TrLang; run: TrRun; runner: TrRunner; keep?: TrSection[] }): JobView {
    // 同一份文件同一种语言只留一个在跑的：重复点「开始」不该烧两遍钱。
    for (const j of this.jobs.values()) {
      if (j.status === "running" && j.doc.abs === input.abs && j.lang === input.lang) return view(j);
    }

    const doc: TrDoc = {
      abs: input.abs,
      lang: input.lang,
      provider: input.run.provider,
      model: input.run.model,
      mtime: Date.now(),
      size: 0,
      startedAt: Date.now(),
      warnings: [],
      sections: [],
    };
    const job: Job = {
      id: randomUUID().slice(0, 8),
      status: "running",
      lang: input.lang,
      provider: input.run.provider,
      model: input.run.model,
      done: 0,
      total: cutSections(input.text).length,
      note: "",
      startedAt: Date.now(),
      doc,
      signal: { aborted: false },
    };
    this.jobs.set(job.id, job);
    this.trim();

    const keep = input.keep?.length ? mapKeep(input.keep) : undefined;
    void translateDoc(input.text, input.run, input.runner, {
      signal: job.signal,
      keep,
      onProgress: (done, total, note) => {
        job.done = done;
        job.total = total;
        job.note = note;
      },
      onSection: (got) => {
        job.doc.sections = got.slice();
        this.persist(job);
      },
    })
      .then(({ sections: all, warnings }) => {
        job.doc.sections = all;
        job.doc.warnings = warnings;
        job.status = job.signal.aborted ? "cancelled" : "done";
        job.finishedAt = Date.now();
        this.persist(job);
      })
      .catch((err: unknown) => {
        job.status = job.signal.aborted ? "cancelled" : "error";
        job.error = String((err as Error)?.message ?? err);
        job.finishedAt = Date.now();
        this.persist(job);
      });

    return view(job);
  }

  /** 落盘时的 mtime/size 由调用方补上（取自真正读盘那一刻的 stat）。 */
  stamp(id: string, mtime: number, size: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.doc.mtime = mtime;
    job.doc.size = size;
  }

  get(id: string): JobView | null {
    const job = this.jobs.get(id);
    return job ? view(job) : null;
  }

  /** 这份文件 + 这种语言正在跑的那个任务（页面重新打开时接着轮询它，不另起一个）。 */
  active(abs: string, lang: TrLang): JobView | null {
    for (const j of this.jobs.values()) {
      if (j.status === "running" && j.doc.abs === abs && j.lang === lang) return view(j);
    }
    return null;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.signal.aborted = true;
    return true;
  }

  /** 译文保存后，正在跑的任务跟着更新基线，不然下一次「更新」会把刚存的手改当脏数据。 */
  patch(abs: string, lang: TrLang, sections: TrSection[]): void {
    for (const job of this.jobs.values()) {
      if (job.doc.abs !== abs || job.lang !== lang) continue;
      // 以磁盘上那份为准：译完到用户改译文之间，文件可能已经被「同步写回」换过一版，
      // 拿 job 里翻译那一刻的 mtime/size 写回去，页面会立刻显示「译文过期」。
      const cur = readDoc(abs, lang) ?? job.doc;
      job.doc = { ...cur, sections };
      writeDoc(job.doc);
    }
  }

  private persist(job: Job): void {
    try {
      writeDoc(job.doc);
    } catch {
      /* 状态目录不可写不该让翻译本身失败 */
    }
  }

  private trim(): void {
    while (this.jobs.size > MAX_JOBS) {
      const oldest = [...this.jobs.values()]
        .filter((j) => j.status !== "running")
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      if (!oldest) return;
      this.jobs.delete(oldest.id);
    }
  }
}

const view = (j: Job): JobView => ({
  id: j.id,
  status: j.status,
  lang: j.lang,
  provider: j.provider,
  model: j.model,
  done: j.done,
  total: j.total,
  note: j.note,
  error: j.error,
  startedAt: j.startedAt,
  finishedAt: j.finishedAt,
});

/** 旧缓存按标题行索引，`translateDoc` 用的也是同一个键。 */
function mapKeep(sections: TrSection[]): Map<string, TrSection> {
  const m = new Map<string, TrSection>();
  for (const s of sections) m.set(s.heading || "\u0000preamble", s);
  return m;
}

export { readDoc };
